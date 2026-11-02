import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m) throw new Error(`time "${hhmm}" must look like 09:00`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes > 24 * 60) throw new Error(`time "${hhmm}" is past midnight`);
  return minutes;
}

// Load a client.yaml and return the validated config plus every derived
// name the build uses. Paths inside the file resolve relative to it.
export function loadClient(path) {
  const file = resolve(path);
  const raw = YAML.parse(readFileSync(file, 'utf8'));
  return normalizeClient(raw, dirname(file));
}

export function normalizeClient(raw, baseDir = '.') {
  const errors = [];
  const need = (key) => {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') errors.push(`missing "${key}"`);
  };
  ['name', 'slug', 'timezone', 'spokenTimezone', 'hours', 'areaCode', 'receptionist', 'services', 'knowledgeBase'].forEach(need);
  if (errors.length) throw new Error(`client config invalid:\n  ${errors.join('\n  ')}`);

  if (!/^[a-z][a-z0-9]{1,15}$/.test(raw.slug)) errors.push('slug must be 2-16 lowercase letters/digits, starting with a letter');
  if (!/^\d{3}$/.test(String(raw.areaCode))) errors.push('areaCode must be 3 digits');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone });
  } catch {
    errors.push(`timezone "${raw.timezone}" is not a valid IANA zone (e.g. America/New_York)`);
  }

  // Hours: a default open/close plus per-day overrides ("closed" or {open, close}).
  const hoursByDay = {};
  let open, close;
  try {
    open = toMinutes(raw.hours.open);
    close = toMinutes(raw.hours.close);
    for (let d = 0; d < 7; d++) {
      const o = raw.hours.days?.[DAYS[d]];
      if (o === 'closed') hoursByDay[d] = null;
      else if (o) hoursByDay[d] = [toMinutes(o.open ?? raw.hours.open), toMinutes(o.close ?? raw.hours.close)];
      else hoursByDay[d] = [open, close];
    }
    for (const key of Object.keys(raw.hours.days ?? {})) {
      if (!DAYS.includes(key)) errors.push(`hours.days.${key}: use sun, mon, tue, wed, thu, fri, sat`);
    }
  } catch (e) {
    errors.push(`hours: ${e.message}`);
  }

  // Services: 8-12 bookable keys, realistic durations, aliases that route.
  const services = raw.services ?? {};
  const keys = Object.keys(services);
  if (keys.length < 1 || keys.length > 12) errors.push(`services: ${keys.length} keys; keep it to 1-12 bookable services`);
  const aliasOwner = new Map();
  for (const [key, svc] of Object.entries(services)) {
    if (!/^[a-z0-9_]+$/.test(key)) errors.push(`services.${key}: keys are lowercase snake_case`);
    if (!svc?.label) errors.push(`services.${key}: missing label`);
    if (!Number.isInteger(svc?.minutes) || svc.minutes < 5 || svc.minutes > 480) errors.push(`services.${key}: minutes must be a whole number 5-480`);
    for (const alias of svc?.aliases ?? []) {
      const a = String(alias).toLowerCase();
      if (aliasOwner.has(a)) errors.push(`alias "${a}" is on both ${aliasOwner.get(a)} and ${key}; it must route to one service`);
      aliasOwner.set(a, key);
    }
  }
  // The longest service has to fit inside the shortest open day, or it can never be booked there.
  const longest = Math.max(...keys.map((k) => services[k]?.minutes ?? 0));
  for (const [d, span] of Object.entries(hoursByDay)) {
    if (span && span[1] - span[0] < longest) errors.push(`hours on ${DAYS[d]} (${span[1] - span[0]} min) are shorter than the longest service (${longest} min)`);
  }
  if (raw.consultService && !services[raw.consultService]) errors.push(`consultService "${raw.consultService}" is not a services key`);

  const phone = raw.phone ?? { mode: 'buy' };
  if (!['buy', 'existing', 'none'].includes(phone.mode)) errors.push('phone.mode must be buy, existing or none');
  if (phone.mode === 'existing' && !/^\+1\d{10}$/.test(phone.number ?? '')) errors.push('phone.number must look like +16175551234 when phone.mode is existing');

  if (errors.length) throw new Error(`client config invalid:\n  ${errors.join('\n  ')}`);

  const slug = raw.slug;
  return {
    ...raw,
    areaCode: String(raw.areaCode),
    frontDesk: raw.frontDesk ?? [],
    consultService: raw.consultService ?? null,
    calendarId: raw.calendarId ?? '',
    phone,
    knowledgeBasePath: resolve(baseDir, raw.knowledgeBase),
    hoursMinutes: { open, close, byDay: hoursByDay },
    derived: {
      workerName: `${slug}-${raw.workerSuffix ?? 'demo'}`,
      kvName: `${slug}_bookings`,
      toolPrefix: `${slug}_`,
      eventPrefix: `[${slug.toUpperCase()} ${(raw.workerSuffix ?? 'demo').toUpperCase()}]`,
      assistantName: `${raw.name} — ${raw.receptionist}`,
      phoneLabel: `${raw.name} ${raw.workerSuffix === 'live' ? 'Line' : 'Demo'} ${raw.areaCode}`,
    },
  };
}

export { DAYS };
