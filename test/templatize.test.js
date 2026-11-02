import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSecrets, templatize } from '../src/templatize.js';

const SECRET = '3f1c2a9e-0000-4000-8000-abcdefabcdef';

const canonical = {
  workerUrl: 'https://elevate-demo.sidarthgaonkar.workers.dev/',
  toolPrefix: '',
  knowledgeBaseFileId: 'kb-123',
  replace: { Elevate: 'CLIENT_NAME', 'Elevate Medical Spa': 'CLIENT_NAME', Ava: 'RECEPTIONIST', 'America/Chicago': 'CLIENT_TZ' },
  forbidden: ['Elevate', 'Lumen'],
};

const apiTool = {
  id: 'tool-1',
  orgId: 'org',
  createdAt: 'x',
  type: 'apiRequest',
  name: 'getServices',
  url: 'https://elevate-demo.sidarthgaonkar.workers.dev/getServices',
  headers: { type: 'object', properties: { 'x-vapi-secret': { type: 'string', value: SECRET } } },
};

const fnTool = {
  id: 'tool-2',
  type: 'function',
  function: { name: 'bookAppointment', description: 'Book at Elevate Medical Spa. Available slots only.' },
  server: { url: 'https://elevate-demo.sidarthgaonkar.workers.dev/bookAppointment', secret: SECRET },
};

const assistant = {
  id: 'asst-1',
  orgId: 'org',
  name: 'Elevate — Ava',
  phoneNumberId: 'pn-1',
  firstMessage: 'Thanks for calling Elevate Medical Spa! This is Ava.',
  model: {
    model: 'gpt-4o',
    toolIds: ['tool-1', 'tool-2'],
    knowledgeBase: { fileIds: ['kb-123'] },
    messages: [{ role: 'system', content: 'Available Monday. {{ "now" | date: "%A", "America/Chicago" }}. Ava works at Elevate. Elevated care.' }],
  },
};

test('extractSecrets finds header values and server.secret', () => {
  assert.deepEqual(extractSecrets(apiTool), [SECRET]);
  assert.deepEqual(extractSecrets(fnTool), [SECRET]);
  assert.deepEqual(extractSecrets({ headers: { 'X-Vapi-Secret': 'direct' } }), ['direct']);
});

test('strips every secret and refuses nothing when it is clean', () => {
  const out = templatize({ assistant, tools: [apiTool, fnTool] }, canonical);
  const all = JSON.stringify(out);
  assert.ok(!all.includes(SECRET));
  assert.equal(out.tools[0].template.headers.properties['x-vapi-secret'].value, '{{VAPI_TOOL_SECRET}}');
  assert.equal(out.tools[1].template.server.secret, '{{VAPI_TOOL_SECRET}}');
  assert.equal(out.report.secretsReplaced, 1);
});

test('replaces the worker URL, KB id and literals, longest first', () => {
  const out = templatize({ assistant, tools: [apiTool, fnTool] }, canonical);
  assert.equal(out.tools[0].template.url, '{{WORKER_URL}}/getServices');
  assert.equal(out.tools[1].template.function.description, 'Book at {{CLIENT_NAME}}. Available slots only.');
  assert.equal(out.assistant.firstMessage, 'Thanks for calling {{CLIENT_NAME}}! This is {{RECEPTIONIST}}.');
  assert.deepEqual(out.assistant.model.knowledgeBase.fileIds, ['{{KB_FILE_ID}}']);
});

test('word boundaries: "Ava" never eats "Available", "Elevate" never eats "Elevated"', () => {
  const out = templatize({ assistant, tools: [apiTool, fnTool] }, canonical);
  const prompt = out.assistant.model.messages[0].content;
  assert.equal(prompt, 'Available Monday. {{ "now" | date: "%A", "{{CLIENT_TZ}}" }}. {{RECEPTIONIST}} works at {{CLIENT_NAME}}. Elevated care.');
});

test('assistant: fixed name, no tool ids, no phone, no read-only fields', () => {
  const a = templatize({ assistant, tools: [apiTool] }, canonical).assistant;
  assert.equal(a.name, '{{CLIENT_NAME}} — {{RECEPTIONIST}}');
  assert.deepEqual(a.model.toolIds, []);
  assert.ok(!('phoneNumberId' in a) && !('id' in a) && !('orgId' in a));
});

test('tool names get the client prefix, canonical prefix removed', () => {
  const prefixed = { ...apiTool, name: 'elv_getServices' };
  const out = templatize({ assistant, tools: [prefixed, fnTool] }, { ...canonical, toolPrefix: 'elv_' });
  assert.equal(out.tools[0].template.name, '{{TOOL_PREFIX}}getServices');
  assert.equal(out.tools[0].file, 'getServices.json');
  assert.equal(out.tools[1].template.function.name, '{{TOOL_PREFIX}}bookAppointment');
  assert.ok(!('id' in out.tools[0].template));
});

test('counts replacements and reports leaks the swaps missed', () => {
  const out = templatize({ assistant, tools: [apiTool, fnTool] }, { ...canonical, forbidden: ['Elevated', 'Lumen'] });
  assert.ok(out.report.counts.CLIENT_NAME >= 3);
  assert.equal(out.report.counts.WORKER_URL, 2);
  assert.deepEqual(out.report.leaks, ['Elevated']);
});

test('a tool without a name is an error', () => {
  assert.throws(() => templatize({ assistant, tools: [{ id: 'x' }] }, canonical), /has no name/);
});
