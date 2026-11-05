#!/usr/bin/env node
// agent-factory CLI. See README for the one-time setup and the per-client flow.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { STEPS, build, dryRun, forbiddenFor, loadCanonical, loadJson, spokenPunctuation } from '../src/build.js';
import * as cf from '../src/cloudflare.js';
import { loadClient } from '../src/config.js';
import { loadEnv, missingEnv } from '../src/env.js';
import { reportMarkdown, runSmokeTests } from '../src/smoke.js';
import { templatize } from '../src/templatize.js';
import { twilioClient } from '../src/twilio.js';
import { vapiClient } from '../src/vapi.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDS = join(ROOT, 'builds');
const CANONICAL = join(ROOT, 'canonical.yaml');

const USAGE = `usage: factory <command>

  pull-canonical [--from-raw]    export the Elevate assistant + tools from Vapi into templates/
                                 (--from-raw: reuse canonical-raw/, no Vapi call)
  new <slug>                     start clients/<slug>/client.yaml and kb.md from the example
  build <client.yaml> [options]  build the client's receptionist
      --dry-run                  render into builds/<slug>/dry-run/ and check; no API calls
      --from <step>              re-run from this step (${STEPS.join(', ')})
      --yes                      allow buying a phone number (it costs money)
      --templates <dir>          template directory (default: templates/)
  test <client.yaml>             smoke-test the live Worker and assistant
`;

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function requireEnv(names) {
  const missing = missingEnv(names);
  if (missing.length) throw new Error(`set ${missing.join(', ')} in .env (copy .env.example; never paste them in chat)`);
}

// --from-raw re-templatizes the last export in canonical-raw/ without calling
// Vapi (after a canonical.yaml or templatize change).
async function pullCanonical(fromRaw) {
  const canonical = loadCanonical(CANONICAL);
  const raw = join(ROOT, 'canonical-raw');
  let assistant;
  let tools;
  if (fromRaw) {
    assistant = JSON.parse(readFileSync(join(raw, 'assistant.json'), 'utf8'));
    tools = (assistant.model?.toolIds ?? []).map((id) => JSON.parse(readFileSync(join(raw, 'tools', `${id}.json`), 'utf8')));
  } else {
    if (!canonical.assistantId) throw new Error('canonical.yaml has no assistantId; fill it in first');
    requireEnv(['VAPI_API_KEY']);
    const vapi = vapiClient(process.env.VAPI_API_KEY);
    assistant = await vapi.getAssistant(canonical.assistantId);
    if (!assistant.model?.toolIds?.length) throw new Error('the canonical assistant has no model.toolIds');
    tools = [];
    for (const id of assistant.model.toolIds) tools.push(await vapi.getTool(id));
    // Raw exports hold the canonical tool secret; canonical-raw/ is gitignored.
    write(join(raw, 'assistant.json'), JSON.stringify(assistant, null, 2) + '\n');
    for (const t of tools) write(join(raw, 'tools', `${t.id}.json`), JSON.stringify(t, null, 2) + '\n');
  }

  const out = templatize({ assistant, tools }, canonical);
  const tdir = join(ROOT, 'templates', 'vapi');
  write(join(tdir, 'assistant.json'), JSON.stringify(out.assistant, null, 2) + '\n');
  for (const t of out.tools) write(join(tdir, 'tools', t.file), JSON.stringify(t.template, null, 2) + '\n');

  console.log(`${fromRaw ? 'Re-templatized' : 'Pulled'} assistant + ${tools.length} tools into templates/vapi/ (raw copies in canonical-raw/, not committed).`);
  console.log('Replacements:');
  for (const [from, token] of Object.entries(canonical.replace ?? {})) console.log(`  ${from} -> {{${token}}}: ${out.report.counts[token] ?? 0}`);
  for (const token of ['WORKER_URL', 'KB_FILE_ID']) if (out.report.counts[token]) console.log(`  {{${token}}}: ${out.report.counts[token]}`);
  console.log(`Tool secrets replaced with {{VAPI_TOOL_SECRET}}: ${out.report.secretsReplaced}`);
  const punct = spokenPunctuation(out.assistant);
  if (punct.length) {
    console.log('\nNon-ASCII punctuation in the canonical prompt (fix it in Vapi, then re-pull):');
    punct.forEach((p) => console.log(`  ${p}`));
  }
  if (out.report.leaks.length) {
    console.log(`\nStill Elevate-specific (tokenize by hand, then git diff): ${out.report.leaks.join(', ')}`);
  }
  console.log('\nNext: review `git diff templates/`, hand-tokenize hours text ({{CLIENT_HOURS}}), the consult line ({{CONSULT_SERVICE}}),');
  console.log('the front-desk line ({{FRONT_DESK_SERVICES}}) and the date table, then commit templates/.');
}

function newClient(slug) {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(slug ?? '')) throw new Error('slug must be 2-16 lowercase letters/digits, starting with a letter');
  const dir = join(ROOT, 'clients', slug);
  if (existsSync(dir)) throw new Error(`clients/${slug} already exists`);
  const doc = YAML.parseDocument(readFileSync(join(ROOT, 'clients', 'example.yaml'), 'utf8'));
  doc.set('slug', slug);
  doc.set('knowledgeBase', 'kb.md');
  write(join(dir, 'client.yaml'), doc.toString());
  write(join(dir, 'kb.md'), '');
  console.log(`Created clients/${slug}/client.yaml and kb.md. Fill both from the Stage 0 research, then:`);
  console.log(`  npm run factory -- build clients/${slug}/client.yaml --dry-run`);
}

function liveDeps() {
  return {
    vapi: vapiClient(process.env.VAPI_API_KEY),
    twilio: twilioClient(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN),
    cf,
  };
}

async function buildCommand(file, values) {
  const client = loadClient(file);
  const canonical = loadCanonical(CANONICAL);
  const templatesDir = resolve(values.templates ?? join(ROOT, 'templates'));
  if (values['dry-run']) {
    const r = dryRun(client, { canonical, templatesDir, buildsDir: BUILDS });
    console.log(`Dry run for ${client.name} (${client.slug}); nothing was called or bought.`);
    console.log('Plan:');
    r.plan.forEach((p) => console.log(`  ${p}`));
    console.log(`Rendered into ${relative(process.cwd(), r.dir) || '.'}:`);
    r.written.forEach((w) => console.log(`  ${w}`));
    console.log(r.complete ? 'All checks passed.' : 'Checks passed for what exists; the dry run is INCOMPLETE until the warnings above are fixed.');
    return;
  }
  requireEnv(['VAPI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'GCP_KEY_FILE']);
  const state = await build(client, {
    canonical,
    templatesDir,
    buildsDir: BUILDS,
    deps: liveDeps(),
    from: values.from,
    yes: values.yes,
  });
  const s = state.steps;
  console.log(`\nBuilt ${client.derived.assistantName}.`);
  console.log(`  Worker:    ${s.worker.workerUrl}`);
  console.log(`  Assistant: ${s.assistant.id}`);
  if (s.phone?.number) console.log(`  Phone:     ${s.phone.number}`);
  console.log(`Next: npm run factory -- test ${file}`);
}

async function testCommand(file) {
  const client = loadClient(file);
  const canonical = loadCanonical(CANONICAL);
  const dir = join(BUILDS, client.slug);
  const state = loadJson(join(dir, 'state.json'), null);
  const secrets = loadJson(join(dir, '.secrets.json'), {});
  if (!state?.steps?.worker?.done || !state.steps.assistant?.done) throw new Error(`${client.slug} has no finished build; run build first`);
  requireEnv(['VAPI_API_KEY']);
  const r = await runSmokeTests(client, {
    workerUrl: state.steps.worker.workerUrl,
    secret: secrets.VAPI_TOOL_SECRET,
    assistantId: state.steps.assistant.id,
    forbidden: forbiddenFor(client, canonical),
    vapi: vapiClient(process.env.VAPI_API_KEY),
  });
  const reportPath = join(dir, 'test-report.md');
  write(reportPath, reportMarkdown(client, r));
  r.results.forEach((t) => console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.name}: ${t.evidence}`));
  console.log(`Report: ${relative(process.cwd(), reportPath)}`);
  if (!r.passed) process.exitCode = 1;
}

async function main() {
  loadEnv(join(ROOT, '.env'));
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'from-raw': { type: 'boolean', default: false },
      from: { type: 'string' },
      yes: { type: 'boolean', default: false },
      templates: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) return void console.log(USAGE);
  if (command === 'pull-canonical') return pullCanonical(values['from-raw']);
  if (command === 'new') return newClient(arg);
  if (!arg) throw new Error(`${command} needs a client.yaml path\n\n${USAGE}`);
  if (command === 'build') return buildCommand(arg, values);
  if (command === 'test') return testCommand(arg);
  throw new Error(`unknown command "${command}"\n\n${USAGE}`);
}

main().catch((e) => {
  console.error(`factory: ${e.message}`);
  process.exitCode = 1;
});
