// The build: one client.yaml in, a live Worker + Vapi tools, KB, assistant
// and phone number out. Each step records what it created in
// builds/<slug>/state.json, so a re-run skips finished steps and never buys
// or creates the same thing twice. Network clients come in through `deps`
// so the whole flow can be dry-run and unit tested.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { wranglerToml } from './cloudflare.js';
import { missingEnv } from './env.js';
import { findLeaks, nonAsciiPunctuation, renderDeep, renderString, renderWorker, tokensFor, tokensUsed } from './render.js';
import { extractSecrets } from './templatize.js';

export const STEPS = ['phone', 'worker', 'tools', 'kb', 'assistant', 'vapi-number'];

const REQUIRED_SECRETS = ['VAPI_TOOL_SECRET', 'GCP_SERVICE_ACCOUNT_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];

export function loadCanonical(path) {
  return YAML.parse(readFileSync(path, 'utf8')) ?? {};
}

// templates/worker/index.js, templates/vapi/assistant.json and
// templates/vapi/tools/*.json. Missing pieces are listed, not thrown, so a
// dry run can still render what exists.
export function loadTemplates(dir) {
  const missing = [];
  const read = (rel) => {
    const p = join(dir, rel);
    if (existsSync(p)) return readFileSync(p, 'utf8');
    missing.push(rel);
    return null;
  };
  const worker = read('worker/index.js');
  const assistantText = read('vapi/assistant.json');
  const toolsDir = join(dir, 'vapi', 'tools');
  const tools = existsSync(toolsDir)
    ? readdirSync(toolsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ base: f.slice(0, -'.json'.length), template: JSON.parse(readFileSync(join(toolsDir, f), 'utf8')) }))
    : [];
  if (!tools.length) missing.push('vapi/tools/*.json');
  return { worker, assistant: assistantText && JSON.parse(assistantText), tools, missing };
}

// The canonical forbidden list, minus any entry that is part of this
// client's own name.
export function forbiddenFor(client, canonical) {
  const own = client.name.toLowerCase();
  return (canonical.forbidden ?? []).filter((f) => f && !own.includes(String(f).toLowerCase()));
}

// Render a template, refusing tokens whose value is empty: a prompt saying
// "our hours are ." is as broken as one saying "{{CLIENT_HOURS}}".
export function renderChecked(value, tokens, what) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const empty = tokensUsed(text).filter((t) => t in tokens && (tokens[t] === '' || tokens[t] == null));
  if (empty.length) {
    throw new Error(`${what} uses ${empty.map((t) => `{{${t}}}`).join(', ')} but the client config leaves it empty (hoursText, consultService, frontDesk, website?)`);
  }
  return typeof value === 'string' ? renderString(value, tokens) : renderDeep(value, tokens);
}

export function toolName(tool) {
  return tool.function?.name ?? tool.name;
}

export function toolUrl(tool) {
  return tool.server?.url ?? tool.url;
}

export function systemPrompt(assistant) {
  return (assistant.model?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
}

// Non-ASCII punctuation in what the assistant says. A warning, not a failure.
export function spokenPunctuation(assistant) {
  return nonAsciiPunctuation(`${assistant.firstMessage ?? ''}\n${systemPrompt(assistant)}`);
}

// Standing rules for the assistant, checked before it is created.
export function checkAssistant(a, client, forbidden) {
  const problems = [];
  const m = a.model ?? {};
  if (m.model !== 'gpt-4o') problems.push(`model.model is ${m.model ?? 'unset'}; it must be gpt-4o, set explicitly (never a preset)`);
  if (m.temperature !== 0.3) problems.push(`model.temperature is ${m.temperature ?? 'unset'}; it must be 0.3, set explicitly`);
  if ((a.endCallPhrases ?? []).length) problems.push('endCallPhrases must be empty (the phrase trigger races the endCall tool)');
  const text = JSON.stringify(a);
  const leaks = findLeaks(text, forbidden);
  if (leaks.length) problems.push(`leakage: ${leaks.join(', ')} appears in the assistant`);
  if (!text.includes(client.timezone)) problems.push(`the client timezone ${client.timezone} appears nowhere in the assistant (are the Liquid date lines tokenized as {{CLIENT_TZ}}?)`);
  const curly = /\{[{%][^}]*[“”‘’][^}]*[}%]\}/.exec(systemPrompt(a));
  if (curly) problems.push(`curly quote inside a Liquid tag: ${curly[0]}`);
  const first = a.firstMessage ?? '';
  if (first && !(first.includes(client.name) && first.includes(client.receptionist))) {
    problems.push('firstMessage must name the client and the receptionist');
  }
  return problems;
}

// Read-back check for one created tool.
export function checkTool(back, { name, url, secret }) {
  const problems = [];
  const warnings = [];
  if (toolName(back) !== name) problems.push(`name is ${toolName(back)}, expected ${name}`);
  if (url && toolUrl(back) !== url) problems.push(`url is ${toolUrl(back)}, expected ${url}`);
  const found = extractSecrets(back);
  if (!found.length) problems.push('no x-vapi-secret header saved');
  else if (!found.includes(secret)) {
    // Vapi may mask a secret on read; a masked value is not a mismatch.
    if (found.some((s) => /[*•]/.test(s))) warnings.push('secret header is masked on read-back; presence confirmed, value not comparable');
    else problems.push('x-vapi-secret header holds a different value');
  }
  return { problems, warnings };
}

export function loadJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function writeFile(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, mode ? { mode } : undefined);
}

// Everything a build renders, with placeholders where a value only exists
// after an earlier step. Shared by --dry-run and the live pre-flight.
export function renderAll(client, canonical, tpl, values) {
  const base = tokensFor(client);
  const out = { tools: [] };
  if (tpl.worker) {
    out.worker = renderChecked(renderWorker(tpl.worker, client, canonical.worker?.serviceFields), base, 'templates/worker/index.js');
  }
  const toolTokens = { ...base, WORKER_URL: values.workerUrl, VAPI_TOOL_SECRET: values.secret };
  for (const t of tpl.tools) {
    out.tools.push({ base: t.base, tool: renderChecked(t.template, toolTokens, `templates/vapi/tools/${t.base}.json`) });
  }
  if (tpl.assistant) {
    const a = renderChecked(tpl.assistant, { ...toolTokens, KB_FILE_ID: values.kbFileId }, 'templates/vapi/assistant.json');
    a.model = { ...a.model, toolIds: tpl.tools.map((t) => values.toolIds[t.base]) };
    out.assistant = a;
  }
  return out;
}

export function workerUrlGuess(client, env) {
  return env.WORKERS_SUBDOMAIN ? `https://${client.derived.workerName}.${env.WORKERS_SUBDOMAIN}.workers.dev` : null;
}

function workerVars(client, state, env) {
  return {
    GOOGLE_CALENDAR_ID: client.calendarId,
    TWILIO_FROM_NUMBER: state.steps.phone?.number ?? client.phone.number,
    TWILIO_MESSAGING_SERVICE_SID: env.TWILIO_MESSAGING_SERVICE_SID,
  };
}

// --dry-run: render every file into builds/<slug>/dry-run/, run every
// pre-create check, call nothing.
export function dryRun(client, { canonical, templatesDir, buildsDir, env = process.env, log = console.log }) {
  const dir = join(buildsDir, client.slug, 'dry-run');
  const tpl = loadTemplates(templatesDir);
  const forbidden = forbiddenFor(client, canonical);
  const warnings = tpl.missing.map((m) => `templates/${m} is missing; run the one-time setup in README (it is skipped in this dry run)`);
  const values = {
    workerUrl: workerUrlGuess(client, env) ?? `https://${client.derived.workerName}.WORKERS_SUBDOMAIN.workers.dev`,
    secret: 'dry-run-not-a-secret',
    kbFileId: 'dry-run-kb-file-id',
    toolIds: Object.fromEntries(tpl.tools.map((t) => [t.base, `dry-run-${client.derived.toolPrefix}${t.base}`])),
  };
  const r = renderAll(client, canonical, tpl, values);
  const written = [];
  const put = (rel, text) => {
    writeFile(join(dir, rel), text);
    written.push(rel);
  };

  if (r.worker) {
    const leaks = findLeaks(r.worker, forbidden);
    if (leaks.length) throw new Error(`leakage: ${leaks.join(', ')} appears in the rendered Worker`);
    put('src/index.js', r.worker);
  }
  put('wrangler.toml', wranglerToml({
    workerName: client.derived.workerName,
    kvId: 'KV_ID_CREATED_AT_BUILD',
    vars: workerVars(client, { steps: {} }, env),
  }));
  for (const { base, tool } of r.tools) {
    const leaks = findLeaks(JSON.stringify(tool), forbidden);
    if (leaks.length) throw new Error(`leakage: ${leaks.join(', ')} appears in tool ${base}`);
    put(`vapi/tools/${client.derived.toolPrefix}${base}.json`, JSON.stringify(tool, null, 2) + '\n');
  }
  if (r.assistant) {
    const problems = checkAssistant(r.assistant, client, forbidden);
    if (problems.length) throw new Error(`assistant fails the standing rules:\n  ${problems.join('\n  ')}`);
    put('vapi/assistant.json', JSON.stringify(r.assistant, null, 2) + '\n');
    warnings.push(...spokenPunctuation(r.assistant).map((p) => `assistant prompt has non-ASCII punctuation: ${p}`));
  }
  const kb = existsSync(client.knowledgeBasePath) ? readFileSync(client.knowledgeBasePath, 'utf8') : '';
  if (!kb.trim()) warnings.push(`knowledge base ${client.knowledgeBasePath} is missing or empty; the live build will refuse it`);
  else {
    const leaks = findLeaks(kb, forbidden);
    if (leaks.length) throw new Error(`leakage: ${leaks.join(', ')} appears in the knowledge base`);
  }

  const d = client.derived;
  const plan = [
    `phone: ${client.phone.mode === 'buy' ? `buy a local ${client.areaCode} number labelled "${d.phoneLabel}" (needs --yes)` : client.phone.mode === 'existing' ? `use ${client.phone.number}` : 'none'}`,
    `worker: deploy ${d.workerName} with KV ${d.kvName}, secrets ${REQUIRED_SECRETS.join(', ')}`,
    `tools: create ${tpl.tools.map((t) => d.toolPrefix + t.base).join(', ') || '(no templates)'}`,
    `kb: upload ${client.knowledgeBase}`,
    `assistant: create "${d.assistantName}"`,
    `vapi-number: ${client.phone.mode === 'none' ? 'skipped' : `import to Vapi as "${d.phoneLabel}"`}`,
  ];
  for (const w of warnings) log(`WARN ${w}`);
  return { dir, written, warnings, plan, complete: tpl.missing.length === 0 && kb.trim() !== '' };
}

// Live build. deps: { vapi, twilio, cf: { ensureKvNamespace, deploy, putSecret, listSecretNames } }.
export async function build(client, { canonical, templatesDir, buildsDir, env = process.env, deps, from, yes = false, log = console.log }) {
  const dir = join(buildsDir, client.slug);
  const statePath = join(dir, 'state.json');
  const secretsPath = join(dir, '.secrets.json');
  const tpl = loadTemplates(templatesDir);
  if (tpl.missing.length) throw new Error(`missing templates: ${tpl.missing.join(', ')}; finish the one-time setup in README first`);
  const kb = existsSync(client.knowledgeBasePath) ? readFileSync(client.knowledgeBasePath, 'utf8') : '';
  if (!kb.trim()) throw new Error(`knowledge base ${client.knowledgeBasePath} is missing or empty`);
  const forbidden = forbiddenFor(client, canonical);

  // The Worker sends SMS through the messaging service, so it is required.
  const needEnv = ['VAPI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'GCP_KEY_FILE'];
  const missing = missingEnv(needEnv, env);
  if (missing.length) throw new Error(`set ${missing.join(', ')} in .env first`);
  if (!existsSync(env.GCP_KEY_FILE)) throw new Error('GCP_KEY_FILE does not point to a file');

  const state = loadJson(statePath, { slug: client.slug, steps: {} });
  const save = () => writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  if (from && !STEPS.includes(from)) throw new Error(`--from must be one of ${STEPS.join(', ')}`);
  const fromIndex = from ? STEPS.indexOf(from) : -1;
  if (from) {
    const unfinished = STEPS.slice(0, fromIndex).filter((s) => !state.steps[s]?.done);
    if (unfinished.length) throw new Error(`--from ${from}: earlier step(s) ${unfinished.join(', ')} have not finished`);
  }
  const forced = (step) => fromIndex !== -1 && STEPS.indexOf(step) >= fromIndex;

  if (client.phone.mode === 'buy' && !state.steps.phone?.number && !yes) {
    throw new Error('this build buys a phone number (about $1.15/month); re-run with --yes to allow it');
  }

  // Pre-flight: render everything with placeholders and run every check
  // before anything is created or bought.
  const pre = renderAll(client, canonical, tpl, {
    workerUrl: 'https://preflight.invalid',
    secret: 'preflight',
    kbFileId: 'preflight',
    toolIds: Object.fromEntries(tpl.tools.map((t) => [t.base, 'preflight'])),
  });
  const preProblems = checkAssistant(pre.assistant, client, forbidden);
  for (const text of [pre.worker, kb, ...pre.tools.map((t) => JSON.stringify(t.tool))]) {
    const leaks = findLeaks(text, forbidden);
    if (leaks.length) preProblems.push(`leakage: ${leaks.join(', ')}`);
  }
  if (preProblems.length) throw new Error(`pre-flight failed, nothing was created:\n  ${preProblems.join('\n  ')}`);
  spokenPunctuation(pre.assistant).forEach((p) => log(`WARN assistant prompt has non-ASCII punctuation: ${p}`));

  const secrets = loadJson(secretsPath, {});
  if (!secrets.VAPI_TOOL_SECRET) {
    secrets.VAPI_TOOL_SECRET = randomUUID();
    writeFile(secretsPath, JSON.stringify(secrets, null, 2) + '\n', 0o600);
  }

  const { vapi, twilio, cf } = deps;
  const d = client.derived;
  const cfOpts = { cwd: dir, env };

  const run = {
    async phone(prev) {
      if (client.phone.mode === 'none') return { skipped: true };
      // A number already bought for this client is reused, never bought again.
      let { number, sid } = prev ?? {};
      if (!number && client.phone.mode === 'existing') {
        const owned = await twilio.findOwned(client.phone.number);
        if (!owned) throw new Error(`${client.phone.number} is not on this Twilio account`);
        ({ phone_number: number, sid } = owned);
      } else if (!number) {
        const candidates = await twilio.searchLocal(client.areaCode);
        if (!candidates.length) throw new Error(`no local numbers available in area code ${client.areaCode}`);
        const bought = await twilio.buy(candidates[0], d.phoneLabel);
        ({ phone_number: number, sid } = bought);
        state.steps.phone = { number, sid, bought: true };
        save();
        log(`  bought ${number}`);
      }
      let messagingService = null;
      if (env.TWILIO_MESSAGING_SERVICE_SID) {
        try {
          await twilio.addToMessagingService(env.TWILIO_MESSAGING_SERVICE_SID, sid);
        } catch (e) {
          // 21710: already in the service, which is the state we want.
          if (!/21710|already/i.test(e.message)) throw e;
        }
        messagingService = env.TWILIO_MESSAGING_SERVICE_SID;
      }
      return { number, sid, bought: prev?.bought ?? client.phone.mode === 'buy', messagingService };
    },

    async worker() {
      writeFile(join(dir, 'src', 'index.js'), pre.worker);
      const kv = await cf.ensureKvNamespace(d.kvName, cfOpts);
      writeFile(join(dir, 'wrangler.toml'), wranglerToml({ workerName: d.workerName, kvId: kv.id, vars: workerVars(client, state, env) }));
      const deployed = await cf.deploy(cfOpts);
      const workerUrl = deployed.url ?? workerUrlGuess(client, env);
      if (!workerUrl) throw new Error('could not read the workers.dev URL from wrangler; set WORKERS_SUBDOMAIN in .env');
      const values = {
        VAPI_TOOL_SECRET: secrets.VAPI_TOOL_SECRET,
        GCP_SERVICE_ACCOUNT_KEY: readFileSync(env.GCP_KEY_FILE, 'utf8'),
        TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      };
      for (const name of REQUIRED_SECRETS) await cf.putSecret(name, values[name], cfOpts);
      const names = await cf.listSecretNames(cfOpts);
      const absent = REQUIRED_SECRETS.filter((n) => !names.includes(n));
      if (absent.length) throw new Error(`Worker secrets missing after put: ${absent.join(', ')}`);
      return { workerUrl, kvId: kv.id, kvCreated: kv.created, version: deployed.version ?? null };
    },

    async tools(prev, isForced) {
      const workerUrl = state.steps.worker.workerUrl;
      // The assistant is rendered too but unused here; its ids come later.
      const r = renderAll(client, canonical, tpl, { workerUrl, secret: secrets.VAPI_TOOL_SECRET, kbFileId: 'pending', toolIds: {} });
      // Resume a half-finished step with the ids it already created; a
      // forced re-run (--from) creates a fresh set.
      const ids = isForced ? {} : { ...(prev?.ids ?? {}) };
      for (const { base, tool } of r.tools) {
        if (!ids[base]) {
          ids[base] = (await vapi.createTool(tool)).id;
          state.steps.tools = { ids };
          save();
        }
        const { problems, warnings } = checkTool(await vapi.getTool(ids[base]), {
          name: `${d.toolPrefix}${base}`,
          url: toolUrl(tool),
          secret: secrets.VAPI_TOOL_SECRET,
        });
        warnings.forEach((w) => log(`  WARN ${base}: ${w}`));
        if (problems.length) throw new Error(`tool ${base} (${ids[base]}) read-back failed:\n  ${problems.join('\n  ')}`);
        log(`  ${d.toolPrefix}${base} ${ids[base]}`);
      }
      return { ids };
    },

    async kb(prev, isForced) {
      let fileId = isForced ? null : prev?.fileId;
      if (!fileId) {
        fileId = (await vapi.uploadFile(`${client.slug}-kb.md`, kb)).id;
        state.steps.kb = { fileId };
        save();
      }
      const back = await vapi.getFile(fileId);
      if (!back?.id) throw new Error(`KB file ${fileId} not found on read-back`);
      if (!JSON.stringify(tpl.assistant).includes('{{KB_FILE_ID}}')) log('  WARN the assistant template never uses {{KB_FILE_ID}}; the KB is uploaded but not attached');
      return { fileId };
    },

    async assistant(prev, isForced) {
      const r = renderAll(client, canonical, tpl, {
        workerUrl: state.steps.worker.workerUrl,
        secret: secrets.VAPI_TOOL_SECRET,
        kbFileId: state.steps.kb.fileId,
        toolIds: state.steps.tools.ids,
      });
      const a = r.assistant;
      const problems = checkAssistant(a, client, forbidden);
      if (problems.length) throw new Error(`assistant fails the standing rules:\n  ${problems.join('\n  ')}`);
      let id = isForced ? null : prev?.id;
      if (!id) {
        id = (await vapi.createAssistant(a)).id;
        state.steps.assistant = { id };
        save();
      }
      const back = await vapi.getAssistant(id);
      const diffs = [];
      if (back.name !== a.name) diffs.push(`name is ${back.name}`);
      if (systemPrompt(back) !== systemPrompt(a)) diffs.push('saved system prompt differs from the rendered one');
      const sorted = (x) => [...(x ?? [])].sort().join(',');
      if (sorted(back.model?.toolIds) !== sorted(a.model.toolIds)) diffs.push('saved toolIds differ from the tools just created');
      if (back.model?.model !== 'gpt-4o' || back.model?.temperature !== 0.3) diffs.push('saved model is not gpt-4o at 0.3');
      if (diffs.length) throw new Error(`assistant ${id} read-back failed:\n  ${diffs.join('\n  ')}`);
      return { id, name: a.name };
    },

    async 'vapi-number'(prev, isForced) {
      if (client.phone.mode === 'none') return { skipped: true };
      const assistantId = state.steps.assistant.id;
      let id = isForced ? null : prev?.id;
      if (!id) {
        id = (await vapi.importTwilioNumber({
          provider: 'twilio',
          number: state.steps.phone.number,
          twilioAccountSid: env.TWILIO_ACCOUNT_SID,
          twilioAuthToken: env.TWILIO_AUTH_TOKEN,
          assistantId,
          // An empty label fails silently in Vapi.
          name: d.phoneLabel,
        })).id;
        state.steps['vapi-number'] = { id };
        save();
      }
      const back = await vapi.getPhoneNumber(id);
      const diffs = [];
      if (back.name !== d.phoneLabel) diffs.push(`label is "${back.name ?? ''}", expected "${d.phoneLabel}"`);
      if (back.assistantId !== assistantId) diffs.push(`bound to assistant ${back.assistantId ?? 'none'}, expected ${assistantId}`);
      if (back.number !== state.steps.phone.number) diffs.push(`number is ${back.number}`);
      if (diffs.length) throw new Error(`Vapi number ${id} read-back failed:\n  ${diffs.join('\n  ')}`);
      return { id, label: d.phoneLabel };
    },
  };

  for (const step of STEPS) {
    const prev = state.steps[step];
    if (prev?.done && !forced(step)) {
      log(`- ${step}: done, skipping`);
      continue;
    }
    log(`- ${step}`);
    const result = await run[step](prev, forced(step));
    state.steps[step] = { ...result, done: true, at: new Date().toISOString() };
    save();
  }
  return state;
}
