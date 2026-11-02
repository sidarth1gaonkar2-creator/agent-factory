// `factory test`: the automatable part of the Stage 4 suite. Hits the live
// Worker with the right and a wrong secret, then talks to the assistant
// through Vapi's chat API. The rest of the 13 tests stay manual for now.

import { findLeaks } from './render.js';

function assistantText(chat) {
  return (chat?.output ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content ?? '')
    .join('\n')
    .trim();
}

export async function runSmokeTests(client, { workerUrl, secret, assistantId, forbidden, vapi, fetchImpl = fetch }) {
  const results = [];
  const record = (name, pass, evidence) => results.push({ name, pass, evidence });

  const getServices = (s) =>
    fetchImpl(`${workerUrl.replace(/\/$/, '')}/getServices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': s },
      body: '{}',
    });

  // 1. getServices with the real secret: every service, nothing foreign.
  try {
    const res = await getServices(secret);
    const body = await res.text();
    const lower = body.toLowerCase();
    const absent = Object.entries(client.services)
      .filter(([key, svc]) => !lower.includes(key) && !lower.includes(svc.label.toLowerCase()))
      .map(([key]) => key);
    const leaks = findLeaks(body, forbidden);
    const problems = [];
    if (res.status !== 200) problems.push(`status ${res.status}`);
    if (absent.length) problems.push(`missing services: ${absent.join(', ')}`);
    if (leaks.length) problems.push(`leakage: ${leaks.join(', ')}`);
    record('getServices with the tool secret', !problems.length, problems.join('; ') || `200, ${Object.keys(client.services).length} services, no foreign names`);
  } catch (e) {
    record('getServices with the tool secret', false, e.message);
  }

  // 2. A wrong secret must be rejected.
  try {
    const res = await getServices('wrong-secret-' + Date.now());
    record('getServices with a wrong secret is rejected', res.status >= 400, `status ${res.status}`);
  } catch (e) {
    record('getServices with a wrong secret is rejected', false, e.message);
  }

  // 3-5. Scripted chat turns in one conversation.
  const turns = [];
  let previousChatId;
  const say = async (input) => {
    const chat = await vapi.chat({ assistantId, input, ...(previousChatId ? { previousChatId } : {}) });
    previousChatId = chat?.id ?? previousChatId;
    const reply = assistantText(chat);
    turns.push({ input, reply });
    return reply;
  };
  try {
    const services = await say('Hi, what services do you offer?');
    const named = Object.values(client.services).filter((s) => services.toLowerCase().includes(s.label.toLowerCase()));
    record('assistant lists services', named.length > 0, `named ${named.length}: ${named.map((s) => s.label).join(', ') || 'none'}`);

    const svc = Object.values(client.services).find((s) => s.label !== client.services[client.consultService]?.label) ?? Object.values(client.services)[0];
    const price = await say(`How much does ${svc.label} cost?`);
    const quoted = /\$\s?\d[\d,.]*|\d[\d,.]*\s?dollars/i.exec(price);
    record('price question gets no number', !quoted, quoted ? `quoted "${quoted[0]}"` : 'no price quoted');
  } catch (e) {
    record('chat harness', false, e.message);
  }
  const allReplies = turns.map((t) => t.reply).join('\n');
  const leaks = findLeaks(allReplies, forbidden);
  record('leakage sweep over every reply', turns.length > 0 && !leaks.length, turns.length ? (leaks.join(', ') || 'clean') : 'no replies to sweep');

  return { results, turns, passed: results.every((r) => r.pass) };
}

export function reportMarkdown(client, { results, turns }, when = new Date()) {
  const lines = [
    `# ${client.name}: automated test report`,
    '',
    `${when.toISOString()} · Worker ${client.derived.workerName}`,
    '',
    '| Test | Result | Evidence |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.pass ? 'PASS' : 'FAIL'} | ${String(r.evidence).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
    '## Transcript',
    '',
    ...turns.flatMap((t) => [`**Caller:** ${t.input}`, '', `**Assistant:** ${t.reply || '(no reply)'}`, '']),
    '## Still manual (Stage 4)',
    '',
    'Weekend and hours edges, "next Wednesday", booking with spelling read-back, pain/downtime deferral,',
    'front-desk service, urgent callback and 911 tier, SMS consent both branches, and the live call.',
    '',
  ];
  return lines.join('\n');
}
