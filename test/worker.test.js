// Behavior tests for templates/worker/index.js: render it for a client, import
// the result and call it like Vapi would, with in-memory KV and a fixed clock.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, mock, test } from 'node:test';
import { loadCanonical } from '../src/build.js';
import { loadClient } from '../src/config.js';
import { findLeaks, renderWorker } from '../src/render.js';
import { ROOT } from './helpers.js';

const canonical = loadCanonical(join(ROOT, 'canonical.yaml'));
const template = readFileSync(join(ROOT, 'templates', 'worker', 'index.js'), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'factory-worker-'));

// Wednesday 2026-11-04, 15:00 UTC: 9:00 AM in Chicago, 10:00 AM in New York.
const NOW = Date.parse('2026-11-04T15:00:00Z');
const MONDAY = '2026-11-09';
const SATURDAY = '2026-11-07';
const SUNDAY = '2026-11-08';

before(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
after(() => {
  mock.timers.reset();
  rmSync(tmp, { recursive: true, force: true });
});

function rendered(slug) {
  const client = loadClient(join(ROOT, 'clients', `${slug}.yaml`));
  return { client, code: renderWorker(template, client, canonical.worker?.serviceFields) };
}

let n = 0;
async function load(slug) {
  const { client, code } = rendered(slug);
  const file = join(tmp, `${slug}-${++n}.mjs`);
  writeFileSync(file, code);
  return { client, worker: (await import(pathToFileURL(file).href)).default };
}

// Workers KV with one key per list page, so pagination is always exercised.
function kv() {
  const data = new Map();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    list: async ({ prefix, cursor }) => {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const i = cursor ? Number(cursor) : 0;
      const done = i + 1 >= keys.length;
      return { keys: keys.slice(i, i + 1).map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(i + 1) };
    },
  };
}

function harness(worker) {
  const env = { VAPI_TOOL_SECRET: 's1', BOOKINGS: kv() };
  const ctx = { waitUntil: (p) => p.catch(() => {}) };
  const call = async (path, body = {}, secret = 's1') => {
    const res = await worker.fetch(
      new Request(`https://w.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vapi-secret': secret },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
    return { status: res.status, result: (await res.json()).result };
  };
  return { env, call };
}

const booking = (over = {}) => ({ name: 'Ana Lopez', phone: '6155550100', lastNameSpelling: 'LOPEZ', ...over });

// Calendar and SMS run in ctx.waitUntil; keep them off the network.
before(() => mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 })));

test('rendered example Worker carries no other client name and only ASCII', () => {
  const { code } = rendered('example');
  assert.deepEqual(findLeaks(code, canonical.forbidden), []);
  assert.deepEqual([...code.matchAll(/[^\x00-\x7f]/g)].map((m) => m[0]), []);
});

test('a wrong secret is rejected; a Vapi-mangled right one is accepted', async () => {
  const { call } = harness((await load('example')).worker);
  assert.equal((await call('/getServices', {}, 'nope')).status, 401);
  assert.equal((await call('/getServices', {}, '", s1"')).status, 200);
});

test('getServices lists every label, consult-first and front-desk lines', async () => {
  const { client, worker } = await load('example');
  const { result } = await harness(worker).call('/getServices');
  for (const s of Object.values(client.services)) assert.ok(result.includes(s.label), s.label);
  assert.match(result, /^Example Aesthetics offers: /);
  assert.match(result, /Botox and Dermal Filler require a consultation first for new patients\./);
  assert.match(result, /Lash extensions, waxing, and retail products are also offered/);
  assert.match(result, /Do not quote prices/);
  assert.deepEqual(findLeaks(result, canonical.forbidden), []);
});

test('closed days are rejected with the real hours', async () => {
  const { call } = harness((await load('example')).worker);
  const check = await call('/checkAvailability', { date: SUNDAY, service: 'facial' });
  assert.match(check.result, /Sunday, 2026-11-08 we are closed\. Example Aesthetics is open Monday through Friday, 9 AM to 5 PM; Saturday, 10 AM to 2 PM Eastern\./);
  const book = await call('/bookAppointment', booking({ service: 'facial', startTime: `${SUNDAY}T10:00` }));
  assert.match(book.result, /closed that day/);
});

test('per-day hours: Saturday closes early for the longest service', async () => {
  const { call } = harness((await load('example')).worker);
  const late = await call('/bookAppointment', booking({ service: 'microneedling', startTime: `${SATURDAY}T13:00` }));
  assert.match(late.result, /runs 75 minutes and Example Aesthetics closes at 2 PM Eastern on Saturdays/);
  const slots = await call('/checkAvailability', { date: SATURDAY, service: 'microneedling' });
  assert.match(slots.result, /: 10 AM, 10:15 AM, .*, 12:30 PM, 12:45 PM Eastern\./);
});

test('overlapping bookings are rejected across KV list pages', async () => {
  const { call, env } = harness((await load('example')).worker);
  assert.match((await call('/bookAppointment', booking({ service: 'consultation', startTime: `${MONDAY}T09:00` }))).result, /^Booked/);
  assert.match((await call('/bookAppointment', booking({ service: 'hydrafacial', startTime: `${MONDAY}T10:00` }))).result, /^Booked/);
  // 10:30 sits inside the second booking, which is on the second list page.
  const clash = await call('/bookAppointment', booking({ service: 'consultation', startTime: `${MONDAY}T10:30` }));
  assert.match(clash.result, /10:30 AM is taken\. Still open: 9:30 AM, 11 AM, 11:15 AM\./);
  assert.equal([...env.BOOKINGS.data.keys()].filter((k) => k.startsWith(`booking:${MONDAY}`)).length, 2);
});

test('new patients are redirected to the consult service', async () => {
  const { call } = harness((await load('example')).worker);
  const r = await call('/bookAppointment', booking({ service: 'botox', isNewPatient: true, startTime: `${MONDAY}T11:00` }));
  assert.match(r.result, /New patients need a consultation before Botox\. .* 30-minute Complimentary Consultation .*service "consultation"/);
});

test('no lastNameSpelling, no booking', async () => {
  const { call, env } = harness((await load('example')).worker);
  const r = await call('/bookAppointment', booking({ lastNameSpelling: '', service: 'facial', startTime: `${MONDAY}T11:00` }));
  assert.match(r.result, /^Cannot book yet: ask the caller to spell their last name/);
  assert.equal(env.BOOKINGS.data.size, 0);
});

test('spelled letters override the transcribed last name', async () => {
  const { call } = harness((await load('example')).worker);
  const r = await call('/bookAppointment', booking({ name: 'Jon Smyth', lastNameSpelling: 'S-M-I-T-H', service: 'facial', startTime: `${MONDAY}T11:00` }));
  assert.match(r.result, /^Booked: Jon Smith,/);
});

test('LEAD_MINUTES: same-day starts need 60 minutes notice (10 AM now)', async () => {
  const { call } = harness((await load('example')).worker);
  const today = '2026-11-04';
  const slots = await call('/checkAvailability', { date: today, service: 'consultation' });
  assert.match(slots.result, /: 11 AM, 11:15 AM/);
  assert.match((await call('/bookAppointment', booking({ service: 'consultation', startTime: `${today}T10:30` }))).result, /too soon - same-day bookings need at least 60 minutes/);
  assert.match((await call('/bookAppointment', booking({ service: 'consultation', startTime: `${today}T09:45` }))).result, /already passed/);
  assert.match((await call('/bookAppointment', booking({ service: 'consultation', startTime: `${today}T11:00` }))).result, /^Booked/);
});

test('urgentCallback logs first and keeps the 911 script verbatim', async () => {
  const { call, env } = harness((await load('example')).worker);
  const r = await call('/urgentCallback', { description: 'trouble breathing after filler' });
  assert.match(r.result, /^Say exactly: 'If you are having trouble breathing or vision changes, please hang up and call 911/);
  assert.match(r.result, /Then ask for their name and best callback number/);
  assert.equal([...env.BOOKINGS.data.keys()].filter((k) => k.startsWith('urgent:')).length, 1);
});

// Elevate parity: the template rendered with clients/elevate.yaml should say
// what the live elevate-demo Worker says.
test('elevate parity: hours, close time, consult redirect, lead time 0', async () => {
  const { worker } = await load('elevate');
  const { call } = harness(worker);
  const closed = await call('/checkAvailability', { date: SATURDAY, service: 'facial' });
  assert.match(closed.result, /Elevate Medical Spa is open Monday through Friday, 10 AM to 4 PM Central\./);
  const late = await call('/bookAppointment', booking({ service: 'sculptra', startTime: `${MONDAY}T15:15` }));
  assert.match(late.result, /closes at 4 PM Central/);
  const redirect = await call('/bookAppointment', booking({ service: 'botox', isNewPatient: true, startTime: `${MONDAY}T11:00` }));
  assert.match(redirect.result, /30-minute New Patient Injectable Consultation instead - call checkAvailability again with service "injectableConsult"/);
  const services = await call('/getServices');
  assert.match(services.result, /Lash and brow services, waxing, and chemical peels are also offered - for those/);
  // 9:00 AM in Chicago: with no lead time every start from opening is offered.
  const today = await call('/checkAvailability', { date: '2026-11-04', service: 'consult' });
  assert.match(today.result, /\(30 minutes\): 10 AM, 10:15 AM, 10:30 AM/);
});

test('elevate parity: the block reproduces the live SERVICES exactly', () => {
  const live = readFileSync(join(ROOT, 'clients', 'elevate.yaml'), 'utf8');
  const { code } = rendered('elevate');
  const services = JSON.parse(/const SERVICES = (\{[\s\S]*?\n\});/.exec(code)[1]);
  assert.equal(Object.keys(services).length, 10);
  assert.deepEqual(services.injectableConsult, {
    label: 'New Patient Injectable Consultation',
    minutes: 30,
    aliases: ['consult', 'consultation', 'new patient', 'first visit', 'injectable consult'],
    newPatientOk: true,
  });
  assert.equal(services.helixLaser.requiresConsultFirst, true);
  assert.ok(live.includes('leadMinutes: 0'));
  assert.match(code, /const LEAD_MINUTES = 0;/);
  assert.match(code, /const EVENT_PREFIX = "\[ELEVATE DEMO\]";/);
});
