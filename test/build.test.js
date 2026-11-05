import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { build, checkAssistant, checkTool, dryRun, forbiddenFor, loadTemplates, renderChecked } from '../src/build.js';
import { loadEnv, missingEnv } from '../src/env.js';
import { CANONICAL, client, FIXTURE_TEMPLATES } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'factory-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function clientWithKb(over = {}, kb = '# Test Spa KB\nPrices at the consultation.\n') {
  const dir = mkdtempSync(join(tmp, 'client-'));
  writeFileSync(join(dir, 'kb.md'), kb);
  return client(over, dir);
}

const quiet = () => {};

// In-memory stand-ins for Vapi, Twilio and Wrangler that save what they get
// and return it on read, like the real APIs.
function fakes() {
  const calls = [];
  let n = 0;
  const store = new Map();
  const create = (kind) => async (body) => {
    const id = `${kind}-${++n}`;
    calls.push([`create ${kind}`, body]);
    store.set(id, { ...structuredClone(body), id });
    return { id };
  };
  const get = (kind) => async (id) => {
    calls.push([`get ${kind}`, id]);
    return store.get(id);
  };
  const vapi = {
    createTool: create('tool'),
    getTool: get('tool'),
    uploadFile: async (name, content) => create('file')({ name, content }),
    getFile: get('file'),
    createAssistant: create('assistant'),
    getAssistant: get('assistant'),
    importTwilioNumber: create('number'),
    getPhoneNumber: get('number'),
  };
  const twilio = {
    searchLocal: async (area) => (calls.push(['search', area]), [`+1${area}5550100`]),
    buy: async (number, label) => (calls.push(['buy', number, label]), { phone_number: number, sid: 'PN1' }),
    findOwned: async (number) => ({ phone_number: number, sid: 'PN2' }),
    addToMessagingService: async (svc, sid) => calls.push(['messaging', svc, sid]),
  };
  const secrets = new Set();
  const cf = {
    ensureKvNamespace: async (title) => (calls.push(['kv', title]), { id: 'a'.repeat(32), created: true }),
    deploy: async () => (calls.push(['deploy']), { url: 'https://tspa-demo.sub.workers.dev', version: 'v1' }),
    putSecret: async (name, value) => {
      assert.ok(value, `${name} has a value`);
      calls.push(['secret', name]);
      secrets.add(name);
    },
    listSecretNames: async () => [...secrets],
  };
  return { calls, store, deps: { vapi, twilio, cf } };
}

function env() {
  const gcp = join(tmp, 'gcp.json');
  writeFileSync(gcp, '{"type":"service_account"}');
  return {
    VAPI_API_KEY: 'k',
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 't',
    TWILIO_MESSAGING_SERVICE_SID: 'MG1',
    GCP_KEY_FILE: gcp,
    WORKERS_SUBDOMAIN: 'sub',
  };
}

test('loadEnv reads KEY=value, skips comments, never overrides', () => {
  const file = join(tmp, '.env');
  writeFileSync(file, '# comment\nA=1\nB="two words"\nexport C=3\nD=\nE=keep\n');
  const e = { E: 'already' };
  assert.equal(loadEnv(file, e), true);
  assert.deepEqual(e, { A: '1', B: 'two words', C: '3', D: '', E: 'already' });
  assert.deepEqual(missingEnv(['A', 'D', 'Z'], e), ['D', 'Z']);
  assert.equal(loadEnv(join(tmp, 'nope'), {}), false);
});

test('loadTemplates lists what is missing', () => {
  assert.deepEqual(loadTemplates(join(tmp, 'empty')).missing, ['worker/index.js', 'vapi/assistant.json', 'vapi/tools/*.json']);
  const t = loadTemplates(FIXTURE_TEMPLATES);
  assert.deepEqual(t.missing, []);
  assert.deepEqual(t.tools.map((x) => x.base), ['bookAppointment', 'getServices']);
});

test('forbiddenFor exempts names inside the client name', () => {
  assert.deepEqual(forbiddenFor(client({ name: 'Lumen Aesthetics' }), CANONICAL), ['Elevate', 'Nashville Skin Society']);
});

test('renderChecked refuses tokens the client left empty', () => {
  assert.throws(() => renderChecked('Hours: {{CLIENT_HOURS}}', { CLIENT_HOURS: '' }, 'prompt'), /prompt uses \{\{CLIENT_HOURS\}\}/);
  assert.equal(renderChecked({ a: '{{X}}' }, { X: 'y' }, 'x').a, 'y');
});

test('checkAssistant enforces the standing rules', () => {
  const c = client();
  const good = {
    firstMessage: 'Thanks for calling Test Spa! This is Claire.',
    model: { model: 'gpt-4o', temperature: 0.3, messages: [{ role: 'system', content: '{{ "now" | date: "%A", "America/Chicago" }}' }] },
  };
  assert.deepEqual(checkAssistant(good, c, ['Elevate']), []);
  const bad = {
    firstMessage: 'Hello!',
    endCallPhrases: ['goodbye'],
    model: { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'At Elevate. {{ “now” | date: "%A" }}' }] },
  };
  const problems = checkAssistant(bad, c, ['Elevate']).join('\n');
  for (const p of [/gpt-4o-mini/, /temperature is unset/, /endCallPhrases/, /leakage: Elevate/, /America\/Chicago appears nowhere/, /curly quote/, /firstMessage/]) {
    assert.match(problems, p);
  }
});

test('checkTool compares name, url and secret', () => {
  const tool = { name: 'tspa_getServices', url: 'https://w/getServices', headers: { properties: { 'x-vapi-secret': { value: 's1' } } } };
  assert.deepEqual(checkTool(tool, { name: 'tspa_getServices', url: 'https://w/getServices', secret: 's1' }).problems, []);
  assert.match(checkTool(tool, { name: 'x', url: 'https://w/getServices', secret: 's2' }).problems.join(), /name is tspa_getServices.*different value/);
  assert.match(checkTool({ name: 'x' }, { name: 'x', secret: 's' }).problems.join(), /no x-vapi-secret/);
  const masked = { name: 'x', server: { secret: '****' } };
  assert.equal(checkTool(masked, { name: 'x', secret: 's' }).warnings.length, 1);
});

test('dry run renders every file and calls nothing', () => {
  const c = clientWithKb();
  const buildsDir = join(tmp, 'builds-dry');
  const r = dryRun(c, { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir, env: { WORKERS_SUBDOMAIN: 'sub' }, log: quiet });
  assert.equal(r.complete, true);
  assert.deepEqual(r.written.sort(), ['src/index.js', 'vapi/assistant.json', 'vapi/tools/tspa_bookAppointment.json', 'vapi/tools/tspa_getServices.json', 'wrangler.toml']);
  const tool = JSON.parse(readFileSync(join(r.dir, 'vapi/tools/tspa_getServices.json'), 'utf8'));
  assert.equal(tool.url, 'https://tspa-demo.sub.workers.dev/getServices');
  const worker = readFileSync(join(r.dir, 'src/index.js'), 'utf8');
  assert.match(worker, /const TZ = "America\/Chicago";/);
  assert.ok(!existsSync(join(buildsDir, 'tspa', 'state.json')));
});

test('dry run without templates warns and is incomplete', () => {
  const r = dryRun(clientWithKb(), { canonical: CANONICAL, templatesDir: join(tmp, 'none'), buildsDir: join(tmp, 'b2'), env: {}, log: quiet });
  assert.equal(r.complete, false);
  assert.equal(r.warnings.length, 3);
});

test('dry run fails on a leak in the knowledge base', () => {
  const c = clientWithKb({}, 'Formerly part of Elevate.');
  assert.throws(() => dryRun(c, { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir: join(tmp, 'b3'), env: {}, log: quiet }), /leakage: Elevate/);
});

test('live build refuses to buy a number without --yes, before calling anything', async () => {
  const f = fakes();
  await assert.rejects(
    build(clientWithKb(), { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir: join(tmp, 'b4'), env: env(), deps: f.deps, log: quiet }),
    /--yes/,
  );
  assert.deepEqual(f.calls, []);
});

test('live build fails pre-flight on a leak, before calling anything', async () => {
  const f = fakes();
  const c = clientWithKb({}, 'We used to be Lumen.');
  await assert.rejects(
    build(c, { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir: join(tmp, 'b5'), env: env(), deps: f.deps, yes: true, log: quiet }),
    /pre-flight failed, nothing was created/,
  );
  assert.deepEqual(f.calls, []);
});

test('live build runs every step, verifies, and records state', async () => {
  const f = fakes();
  const buildsDir = join(tmp, 'b6');
  const opts = { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir, env: env(), deps: f.deps, yes: true, log: quiet };
  const state = await build(clientWithKb(), opts);

  assert.equal(state.steps.phone.number, '+16155550100');
  assert.deepEqual(f.calls.find((c) => c[0] === 'buy'), ['buy', '+16155550100', 'Test Spa Demo 615']);
  assert.ok(f.calls.some((c) => c[0] === 'messaging' && c[2] === 'PN1'));
  assert.equal(state.steps.worker.workerUrl, 'https://tspa-demo.sub.workers.dev');
  assert.deepEqual(f.calls.filter((c) => c[0] === 'secret').map((c) => c[1]), ['VAPI_TOOL_SECRET', 'GCP_SERVICE_ACCOUNT_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']);

  const toml = readFileSync(join(buildsDir, 'tspa', 'wrangler.toml'), 'utf8');
  assert.match(toml, /TWILIO_FROM_NUMBER = "\+16155550100"/);
  assert.match(toml, /id = "a{32}"/);

  const secret = JSON.parse(readFileSync(join(buildsDir, 'tspa', '.secrets.json'), 'utf8')).VAPI_TOOL_SECRET;
  assert.match(secret, /^[0-9a-f-]{36}$/);
  assert.ok(!readFileSync(join(buildsDir, 'tspa', 'state.json'), 'utf8').includes(secret), 'state.json never holds the secret');
  assert.ok(!toml.includes(secret), 'wrangler.toml never holds the secret');

  const tool = f.store.get(state.steps.tools.ids.getServices);
  assert.equal(tool.name, 'tspa_getServices');
  assert.equal(tool.headers.properties['x-vapi-secret'].value, secret);

  const a = f.store.get(state.steps.assistant.id);
  assert.equal(a.name, 'Test Spa — Claire');
  assert.deepEqual(a.model.toolIds, [state.steps.tools.ids.bookAppointment, state.steps.tools.ids.getServices]);
  assert.deepEqual(a.model.knowledgeBase.fileIds, [state.steps.kb.fileId]);

  const num = f.store.get(state.steps['vapi-number'].id);
  assert.deepEqual(
    { name: num.name, assistantId: num.assistantId, number: num.number },
    { name: 'Test Spa Demo 615', assistantId: state.steps.assistant.id, number: '+16155550100' },
  );

  // A second run skips every finished step and creates nothing.
  const again = fakes();
  await build(clientWithKb(), { ...opts, deps: again.deps });
  assert.deepEqual(again.calls, []);
});

test('--from re-runs later steps but never buys the number again', async () => {
  const f = fakes();
  const buildsDir = join(tmp, 'b7');
  const opts = { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir, env: env(), deps: f.deps, yes: true, log: quiet };
  const c = clientWithKb();
  await build(c, opts);

  const g = fakes();
  await build(c, { ...opts, deps: g.deps, from: 'phone' });
  assert.ok(!g.calls.some((x) => x[0] === 'buy' || x[0] === 'search'));

  const h = fakes();
  const state = await build(c, { ...opts, deps: h.deps, from: 'assistant' });
  assert.deepEqual(h.calls.filter((x) => x[0].startsWith('create')).map((x) => x[0]), ['create assistant', 'create number']);
  assert.ok(state.steps.assistant.done);

  await assert.rejects(build(c, { ...opts, from: 'deploy' }), /--from must be one of/);
});

test('a failed read-back stops the build and keeps what was created', async () => {
  const f = fakes();
  f.deps.vapi.getAssistant = async (id) => ({ id, name: 'Wrong', model: {} });
  const buildsDir = join(tmp, 'b8');
  const c = clientWithKb({ phone: { mode: 'none' } });
  await assert.rejects(
    build(c, { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir, env: env(), deps: f.deps, log: quiet }),
    /read-back failed/,
  );
  const state = JSON.parse(readFileSync(join(buildsDir, 'tspa', 'state.json'), 'utf8'));
  assert.ok(state.steps.assistant.id && !state.steps.assistant.done);
  assert.equal(state.steps.phone.skipped, true);
  assert.ok(!f.calls.some((x) => x[0] === 'buy'));
});

test('existing phone mode uses the owned number', async () => {
  const f = fakes();
  const c = clientWithKb({ phone: { mode: 'existing', number: '+16155559999' } });
  const state = await build(c, { canonical: CANONICAL, templatesDir: FIXTURE_TEMPLATES, buildsDir: join(tmp, 'b9'), env: env(), deps: f.deps, log: quiet });
  assert.deepEqual([state.steps.phone.number, state.steps.phone.sid], ['+16155559999', 'PN2']);
  assert.ok(!f.calls.some((x) => x[0] === 'buy'));
});

test('an em dash in the prompt is a dry-run warning, not a failure', () => {
  const tpl = join(tmp, 'tpl-dash');
  cpSync(FIXTURE_TEMPLATES, tpl, { recursive: true });
  const file = join(tpl, 'vapi', 'assistant.json');
  const a = JSON.parse(readFileSync(file, 'utf8'));
  a.model.messages[0].content += ' Keep sentences short — this is a live call.';
  writeFileSync(file, JSON.stringify(a));
  const r = dryRun(clientWithKb(), { canonical: CANONICAL, templatesDir: tpl, buildsDir: join(tmp, 'b10'), env: {}, log: quiet });
  assert.ok(r.warnings.some((w) => /em dash in/.test(w)));
  assert.equal(r.written.includes('vapi/assistant.json'), true);
});
