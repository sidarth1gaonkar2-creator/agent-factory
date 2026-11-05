// Turn the live canonical build (the current Elevate assistant and its tools,
// exported raw from Vapi) into client-neutral templates. Pure functions; the
// CLI does the reading and writing.

import { stripReadOnly } from './render.js';

// Keys whose string value is the tool secret: the x-vapi-secret header, or
// `server.secret`, which Vapi sends as that header for function tools.
const SECRET_HEADER = /^(x-vapi-secret|secret)$/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace a literal value with {{TOKEN}}. Values that start or end with a
// letter only match on word boundaries, so "Ava" never eats "Available".
function literalPattern(from) {
  const left = /^\w/.test(from) ? '\\b' : '';
  const right = /\w$/.test(from) ? '\\b' : '';
  return new RegExp(`${left}${escapeRegExp(from)}${right}`, 'g');
}

// Walk a JSON value, applying fn to every string. fn gets the string and the
// key it sits under.
function mapStrings(value, fn, key = null) {
  if (typeof value === 'string') return fn(value, key);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, k)]));
  }
  return value;
}

// Find the tool secret wherever Vapi stores it in a tool: as a header value
// keyed x-vapi-secret (directly or as a schema property's `value`), or as
// `server.secret`.
export function extractSecrets(tool) {
  const found = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) {
      if (SECRET_HEADER.test(k)) {
        if (typeof child === 'string') found.add(child);
        else if (child && typeof child.value === 'string') found.add(child.value);
        else if (child && typeof child.default === 'string') found.add(child.default);
      }
      walk(child);
    }
  };
  walk(tool);
  return [...found].filter(Boolean);
}

// canonical: the parsed canonical.yaml. Returns { assistant, tools, report }
// where tools is [{ file, template }] and report counts every replacement.
export function templatize({ assistant, tools }, canonical) {
  const counts = {};
  const replacements = Object.entries(canonical.replace ?? {})
    // Longest first, so "Elevate Medical Spa" is replaced before "Elevate".
    .sort((a, b) => b[0].length - a[0].length);
  if (canonical.workerUrl) replacements.unshift([canonical.workerUrl.replace(/\/$/, ''), 'WORKER_URL']);

  const secrets = new Set(tools.flatMap(extractSecrets));
  if (canonical.knowledgeBaseFileId) replacements.unshift([canonical.knowledgeBaseFileId, 'KB_FILE_ID']);

  const swap = (text, key) => {
    if (key && SECRET_HEADER.test(key)) return '{{VAPI_TOOL_SECRET}}';
    if (secrets.has(text)) return '{{VAPI_TOOL_SECRET}}';
    let out = text;
    for (const [from, token] of replacements) {
      out = out.replace(literalPattern(from), () => {
        counts[token] = (counts[token] ?? 0) + 1;
        return `{{${token}}}`;
      });
    }
    return out;
  };

  const prefix = canonical.toolPrefix ?? '';
  const seen = new Set();
  const toolTemplates = tools.map((raw) => {
    // apiRequest tools keep their real name in `name`; their function.name is
    // the generic "api_request_tool". Function tools only have function.name.
    const name = raw.name ?? raw.function?.name;
    if (!name) throw new Error(`canonical tool ${raw.id} has no name`);
    const base = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const t = mapStrings(stripReadOnly(raw), swap);
    // Every client gets its own prefixed copy; the flat Vapi tool list is
    // unusable without prefixes.
    if (t.name) t.name = `{{TOOL_PREFIX}}${base}`;
    if (raw.function?.name === name) t.function.name = `{{TOOL_PREFIX}}${base}`;
    if (seen.has(base)) throw new Error(`two canonical tools are both named ${base}; refusing to overwrite one with the other`);
    seen.add(base);
    return { file: `${base}.json`, base, canonicalId: raw.id, template: t };
  });

  const a = mapStrings(stripReadOnly(assistant), swap);
  a.name = '{{CLIENT_NAME}} — {{RECEPTIONIST}}';
  // Tool ids are filled at build time from the tools just created.
  if (a.model) a.model.toolIds = [];
  delete a.phoneNumberId;

  // Final guard: no secret survives into a template, in any field.
  const all = JSON.stringify({ a, toolTemplates });
  for (const s of secrets) {
    if (all.includes(s)) throw new Error('a canonical tool secret is still present in the templates; refusing to write them');
  }
  const leaks = (canonical.forbidden ?? []).filter((f) => all.toLowerCase().includes(f.toLowerCase()));

  return {
    assistant: a,
    tools: toolTemplates,
    report: { counts, secretsReplaced: secrets.size, leaks },
  };
}
