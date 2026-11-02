import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportMarkdown, runSmokeTests } from '../src/smoke.js';
import { client } from './helpers.js';

function worker(body, secret = 's1') {
  return async (url, init) => {
    assert.match(url, /\/getServices$/);
    if (init.headers['x-vapi-secret'] !== secret) return new Response('unauthorized', { status: 401 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

function chat(replies) {
  const inputs = [];
  return {
    inputs,
    vapi: {
      chat: async (b) => {
        inputs.push(b);
        return { id: `chat-${inputs.length}`, output: [{ role: 'assistant', content: replies[inputs.length - 1] }] };
      },
    },
  };
}

const opts = (fetchImpl, vapi) => ({ workerUrl: 'https://w/', secret: 's1', assistantId: 'a1', forbidden: ['Elevate'], vapi, fetchImpl });

test('all pass against a good worker and assistant', async () => {
  const c = chat(['We offer a Consultation and a Signature Facial.', 'Pricing is covered at your consultation.']);
  const r = await runSmokeTests(client(), opts(worker({ consultation: {}, facial: {} }), c.vapi));
  assert.ok(r.passed, JSON.stringify(r.results));
  assert.equal(c.inputs[1].previousChatId, 'chat-1');
  assert.equal(c.inputs[1].input, 'How much does Signature Facial cost?');
  const md = reportMarkdown(client(), r, new Date('2026-11-02T00:00:00Z'));
  assert.match(md, /\| getServices with the tool secret \| PASS \|/);
  assert.match(md, /\*\*Caller:\*\* Hi, what services do you offer\?/);
});

test('flags missing services, an open worker, prices and leaks', async () => {
  const c = chat(['At Elevate we do facials.', 'That is $350.']);
  const open = async () => new Response(JSON.stringify({ consultation: {} }), { status: 200 });
  const r = await runSmokeTests(client(), opts(open, c.vapi));
  const byName = Object.fromEntries(r.results.map((x) => [x.name, x]));
  assert.equal(r.passed, false);
  assert.match(byName['getServices with the tool secret'].evidence, /missing services: facial/);
  assert.equal(byName['getServices with a wrong secret is rejected'].pass, false);
  assert.match(byName['price question gets no number'].evidence, /\$350/);
  assert.match(byName['leakage sweep over every reply'].evidence, /Elevate/);
});

test('a chat API error is a failure, not a crash', async () => {
  const vapi = { chat: async () => { throw new Error('Vapi POST /chat failed: 401'); } };
  const r = await runSmokeTests(client(), opts(worker({ consultation: {}, facial: {} }), vapi));
  assert.equal(r.passed, false);
  assert.ok(r.results.some((x) => x.name === 'chat harness' && /401/.test(x.evidence)));
});
