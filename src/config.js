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
  ['name', 'slug', 'location', 'timezone', 'spokenTimezone', 'hours', 'areaCode', 'receptionist', 'services', 'knowledgeBase'].forEach(need);
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
    // camelCase is allowed so the canonical Elevate keys can be reproduced.
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) errors.push(`services.${key}: keys are letters, digits and _ (snake_case for new clients)`);
    if (!svc?.label) errors.push(`services.${key}: missing label`);
    if (!Number.isInteger(svc?.minutes) || svc.minutes < 5 || svc.minutes > 480) errors.push(`services.${key}: minutes must be a whole number 5-480`);
    for (const flag of ['newPatientOk', 'requiresConsultFirst']) {
      if (svc?.[flag] !== undefined && typeof svc[flag] !== 'boolean') errors.push(`services.${key}.${flag} must be true or false`);
    }
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
  if (!raw.consultService && keys.some((k) => services[k]?.requiresConsultFirst)) errors.push('consultService is required when a service has requiresConsultFirst');
  const leadMinutes = raw.leadMinutes ?? 60;
  if (!Number.isInteger(leadMinutes) || leadMinutes < 0 || leadMinutes > 1440) errors.push('leadMinutes must be a whole number 0-1440');

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
    hoursText: raw.hoursText || hoursSentence(hoursByDay, raw.spokenTimezone),
    leadMinutes,
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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function spokenTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 || 12;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 && h < 24 ? 'PM' : 'AM'}`;
}

export function andList(items) {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

// "Monday through Friday, 10 AM to 4 PM Central; closed Saturday and Sunday",
// from the per-day hours. Used when client.yaml has no hoursText.
export function hoursSentence(byDay, spokenTimezone) {
  const groups = [];
  const closed = [];
  let prev = null;
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const h = byDay[d];
    const last = groups.at(-1);
    if (!h) closed.push(DAY_NAMES[d]);
    else if (last && prev === last.end && last.h[0] === h[0] && last.h[1] === h[1]) last.end = d;
    else groups.push({ start: d, end: d, h });
    prev = h ? d : null;
  }
  const open = groups.map((g) => {
    const days = g.start === g.end ? DAY_NAMES[g.start] : `${DAY_NAMES[g.start]} through ${DAY_NAMES[g.end]}`;
    return `${days}, ${spokenTime(g.h[0])} to ${spokenTime(g.h[1])}`;
  });
  return `${open.join('; ')} ${spokenTimezone}${closed.length ? `; closed ${andList(closed)}` : ''}`;
}

export { DAYS };
