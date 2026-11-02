import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadClient, normalizeClient, toMinutes } from '../src/config.js';
import { client, rawClient, ROOT } from './helpers.js';

test('toMinutes parses HH:MM and rejects junk', () => {
  assert.equal(toMinutes('09:00'), 540);
  assert.equal(toMinutes('17:30'), 1050);
  assert.throws(() => toMinutes('9am'), /must look like 09:00/);
  assert.throws(() => toMinutes('25:00'), /past midnight/);
});

test('derives names from the slug', () => {
  assert.deepEqual(client().derived, {
    workerName: 'tspa-demo',
    kvName: 'tspa_bookings',
    toolPrefix: 'tspa_',
    eventPrefix: '[TSPA DEMO]',
    assistantName: 'Test Spa — Claire',
    phoneLabel: 'Test Spa Demo 615',
  });
});

test('per-day hours: closed days are null, overrides apply', () => {
  const { byDay, open, close } = client().hoursMinutes;
  assert.equal(open, 540);
  assert.equal(close, 1020);
  assert.equal(byDay[0], null);
  assert.deepEqual(byDay[6], [600, 840]);
  assert.deepEqual(byDay[1], [540, 1020]);
});

test('lists every missing required field at once', () => {
  const raw = rawClient();
  delete raw.slug;
  delete raw.timezone;
  assert.throws(() => normalizeClient(raw), (e) => /missing "slug"/.test(e.message) && /missing "timezone"/.test(e.message));
});

test('rejects a bad slug, area code and timezone', () => {
  assert.throws(() => client({ slug: 'Bad Slug' }), /slug must be/);
  assert.throws(() => client({ areaCode: '61' }), /areaCode must be 3 digits/);
  assert.throws(() => client({ timezone: 'Central' }), /not a valid IANA zone/);
});

test('rejects an unknown day key in hours', () => {
  const hours = { open: '09:00', close: '17:00', days: { monday: 'closed' } };
  assert.throws(() => client({ hours }), /hours.days.monday/);
});

test('an alias may route to only one service, case-insensitively', () => {
  const services = {
    a: { label: 'A', minutes: 30, aliases: ['Facial'] },
    b: { label: 'B', minutes: 30, aliases: ['facial'] },
  };
  assert.throws(() => client({ services, consultService: 'a' }), /alias "facial" is on both a and b/);
});

test('the longest service must fit every open day', () => {
  const services = { long: { label: 'Long', minutes: 300 } };
  assert.throws(() => client({ services, consultService: 'long' }), /hours on sat \(240 min\) are shorter than the longest service \(300 min\)/);
});

test('more than 12 services is rejected', () => {
  const services = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`s${i}`, { label: `S${i}`, minutes: 30 }]));
  assert.throws(() => client({ services, consultService: undefined }), /13 keys/);
});

test('consultService must be a services key', () => {
  assert.throws(() => client({ consultService: 'botox' }), /consultService "botox"/);
});

test('phone modes', () => {
  assert.equal(client().phone.mode, 'buy');
  assert.throws(() => client({ phone: { mode: 'rent' } }), /phone.mode/);
  assert.throws(() => client({ phone: { mode: 'existing', number: '615-555-1234' } }), /phone.number/);
  assert.equal(client({ phone: { mode: 'existing', number: '+16155551234' } }).phone.number, '+16155551234');
});

test('workerSuffix live changes the derived names', () => {
  const d = client({ workerSuffix: 'live' }).derived;
  assert.equal(d.workerName, 'tspa-live');
  assert.equal(d.eventPrefix, '[TSPA LIVE]');
  assert.equal(d.phoneLabel, 'Test Spa Line 615');
});

test('the example client is valid', () => {
  const c = loadClient(join(ROOT, 'clients', 'example.yaml'));
  assert.equal(c.slug, 'example');
  assert.equal(c.knowledgeBasePath, join(ROOT, 'clients', 'example-kb.md'));
});
