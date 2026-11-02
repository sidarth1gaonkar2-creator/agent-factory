import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLeaks, renderDeep, renderString, renderWorker, stripReadOnly, tokensFor, tokensUsed, workerConfigBlock } from '../src/render.js';
import { client } from './helpers.js';

test('tokensFor maps the client config', () => {
  const t = tokensFor(client(), { WORKER_URL: 'https://x' });
  assert.equal(t.CLIENT_NAME, 'Test Spa');
  assert.equal(t.TOOL_PREFIX, 'tspa_');
  assert.equal(t.CONSULT_SERVICE, 'Consultation');
  assert.equal(t.FRONT_DESK_SERVICES, 'waxing');
  assert.equal(t.WORKER_URL, 'https://x');
});

test('renderString replaces tokens and errors on unknown ones', () => {
  assert.equal(renderString('Hi {{A}} and {{A}}', { A: 'x' }), 'Hi x and x');
  assert.throws(() => renderString('{{A}} {{NOPE}}', { A: 'x' }), /unknown token\(s\): NOPE/);
});

test('renderString leaves Liquid tags alone', () => {
  const liquid = '{{ "now" | date: "%A", "{{CLIENT_TZ}}" }}';
  assert.equal(renderString(liquid, { CLIENT_TZ: 'America/Chicago' }), '{{ "now" | date: "%A", "America/Chicago" }}');
});

test('renderDeep renders strings at any depth and keeps other values', () => {
  const out = renderDeep({ a: ['{{X}}', 3, { b: '{{X}}!' }], t: true, n: null }, { X: 'y' });
  assert.deepEqual(out, { a: ['y', 3, { b: 'y!' }], t: true, n: null });
});

test('tokensUsed lists each token once', () => {
  assert.deepEqual(tokensUsed('{{A}} {{B}} {{A}} {{ lower }}'), ['A', 'B']);
});

test('findLeaks is case-insensitive', () => {
  assert.deepEqual(findLeaks('Welcome to ELEVATE spa', ['Elevate', 'Lumen', '']), ['Elevate']);
  assert.deepEqual(findLeaks('clean', ['Elevate']), []);
});

test('workerConfigBlock uses the canonical field names and lowercases aliases', () => {
  const block = workerConfigBlock(client(), { label: 'title', minutes: 'mins' });
  assert.match(block, /const TZ = "America\/Chicago";/);
  assert.match(block, /const EVENT_PREFIX = "\[TSPA DEMO\]";/);
  const services = JSON.parse(/const SERVICES = (\{[\s\S]*?\n\});/.exec(block)[1]);
  assert.deepEqual(services.facial, { title: 'Signature Facial', mins: 60, aliases: ['facial', 'classic facial'] });
  // The generated block must itself be valid JavaScript.
  new Function(block);
});

test('renderWorker swaps exactly the marked block', () => {
  const tpl = 'before\n// @factory:client-config:start\nconst OLD = 1;\n// @factory:client-config:end\nafter';
  const out = renderWorker(tpl, client());
  assert.ok(out.startsWith('before\n// @factory:client-config:start'));
  assert.ok(out.endsWith('// @factory:client-config:end\nafter'));
  assert.ok(!out.includes('OLD'));
});

test('renderWorker refuses a template without markers or with two blocks', () => {
  assert.throws(() => renderWorker('const SERVICES = {};', client()), /no \/\/ @factory:client-config:start/);
  const twice = '// @factory:client-config:start\n// @factory:client-config:end\n'.repeat(2);
  assert.throws(() => renderWorker(twice, client()), /more than one/);
});

test('stripReadOnly removes Vapi-managed fields without touching the input', () => {
  const src = { id: '1', orgId: 'o', createdAt: 'c', updatedAt: 'u', isServerUrlSecretSet: true, name: 'n' };
  assert.deepEqual(stripReadOnly(src), { name: 'n' });
  assert.equal(src.id, '1');
});
