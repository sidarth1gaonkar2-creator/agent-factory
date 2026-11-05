/**
 * Demo receptionist - Vapi tool endpoints (Cloudflare Worker)
 *
 * Canonical template generated from the live canonical demo Worker
 * (version 3090ecac). agent-factory replaces the client-config block below per client;
 * everything else is client-neutral. Fix behavior here first, then rebuild.
 *
 * Endpoints: POST /getServices, /checkAvailability, /bookAppointment,
 * /urgentCallback - flat JSON per Vapi "API Request" tools.
 */

// @factory:client-config:start
const BUSINESS_NAME = "Canonical Business";
const TZ = "America/Chicago";
const SPOKEN_TZ = "Central";
const OPEN = 600;
const CLOSE = 960;
const HOURS_BY_DAY = {"0":null,"1":[600,960],"2":[600,960],"3":[600,960],"4":[600,960],"5":[600,960],"6":null};
const CLOSE_BY_DAY = Object.fromEntries(Object.entries(HOURS_BY_DAY).map(([d, h]) => [d, h ? h[1] : null]));
const EVENT_PREFIX = "[CANONICAL DEMO]";
const LEAD_MINUTES = 0;
const CONSULT_KEY = "consult";
const SERVICES = {
  "consult": { "label": "Consultation", "minutes": 30, "aliases": ["consult"], "newPatientOk": true }
};
const FRONT_DESK = [];
// @factory:client-config:end

const GRID = 15;
const MAX_DAYS_OUT = 60;

function resolveService(input) {
  const q = String(input ?? "").trim().toLowerCase();
  if (!q) return null;
  if (SERVICES[q]) return { key: q, ...SERVICES[q] };
  // Pass 1: exact alias match anywhere in the catalog
  for (const [key, s] of Object.entries(SERVICES)) {
    if (s.aliases.some((a) => a === q)) return { key, ...s };
  }
  // Pass 2: substring fallback (caller said more or less than the alias)
  for (const [key, s] of Object.entries(SERVICES)) {
    if (s.aliases.some((a) => q.includes(a) || a.includes(q))) return { key, ...s };
  }
  return null;
}
/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("POST only", { status: 405 });

    // Vapi mangles static header values (leading '", ' / trailing '"').
    const raw = request.headers.get("x-vapi-secret") ?? "";
    const provided = raw.replace(/^[",\s]+|[",\s]+$/g, "");
    if (!env.VAPI_TOOL_SECRET || provided !== env.VAPI_TOOL_SECRET) {
      return json({ result: "Unauthorized" }, 401);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    let args = {};
    try { args = await request.json(); } catch { /* empty body ok */ }

    try {
      if (path.endsWith("/getServices")) return json({ result: getServices() });
      if (path.endsWith("/checkAvailability")) return json({ result: await checkAvailability(args, env) });
      if (path.endsWith("/bookAppointment")) return json({ result: await bookAppointment(args, env, ctx) });
      if (path.endsWith("/urgentCallback")) return json({ result: await urgentCallback(args, env) });
      return json({ result: `Unknown endpoint: ${path}` }, 404);
    } catch (e) {
      console.error("handler error", path, e);
      return json({
        result:
          "I'm having trouble reaching the schedule right now. Apologize and " +
          "offer to have someone call the patient back.",
      });
    }
  },
};

/* ------------------------------------------------------------------ */
/* Tool: getServices                                                   */
/* ------------------------------------------------------------------ */

function getServices() {
  const lines = Object.values(SERVICES).map((s) => `${s.label} (${s.minutes} minutes)`);
  const consultFirst = Object.values(SERVICES).filter((s) => s.requiresConsultFirst).map((s) => s.label);
  return (
    `${BUSINESS_NAME} offers: ${lines.join("; ")}. ` +
    (consultFirst.length
      ? `${sentenceList(consultFirst)} require a consultation first for new patients. `
      : "") +
    (FRONT_DESK.length
      ? `${capitalize(sentenceList(FRONT_DESK))} are also offered - for those, take the ` +
        `caller's name and number and say the front desk will confirm the booking. `
      : "") +
    `Do not quote prices - pricing is discussed at the consultation. ` +
    `Mention two or three relevant services, not the whole list.`
  );
}

/* ------------------------------------------------------------------ */
/* Tool: checkAvailability                                             */
/* ------------------------------------------------------------------ */

async function checkAvailability(args, env) {
  const date = String(args.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "I need the date as YYYY-MM-DD. Ask which day the patient prefers.";
  }

  const service = resolveService(args.service);
  if (!service) {
    return (
      `I don't recognize that service. Ask which treatment they're interested in. ` +
      `Bookable: ${Object.values(SERVICES).map((s) => s.label).join(", ")}.`
    );
  }

  const dayName = weekdayName(date);

  if (args.expectedWeekday) {
    const expected = String(args.expectedWeekday).trim().toLowerCase();
    if (expected && expected !== dayName.toLowerCase()) {
      return (
        `MISMATCH: ${date} is a ${dayName}, not a ${args.expectedWeekday}. ` +
        `Do not book. Ask the patient to confirm which date they mean.`
      );
    }
  }

  if (!isOpenDay(date)) {
    return `${dayName}, ${date} we are closed. ${BUSINESS_NAME} is open ${hoursSentence()}. Offer a day we are open.`;
  }
  if (date < todayLocal()) return `${dayName}, ${date} is in the past. Ask for an upcoming day we are open.`;
  if (daysOut(date) > MAX_DAYS_OUT) {
    return `${date} is more than ${MAX_DAYS_OUT} days out - we don't book that far ahead. Ask for a nearer date.`;
  }

  const busy = await busyIntervals(date, env);
  const open = openStarts(date, service.minutes, busy);

  if (open.length === 0) {
    return `On ${dayName}, ${date} there is no ${service.minutes}-minute opening for ${service.label}. Suggest a different day.`;
  }

  return (
    `On ${dayName}, ${date} these start times are open for ${service.label} ` +
    `(${service.minutes} minutes): ${open.map(to12Hour).join(", ")} ${SPOKEN_TZ}. ` +
    `Offer only two or three of these, then ask which works.`
  );
}

/* ------------------------------------------------------------------ */
/* Tool: bookAppointment                                               */
/* ------------------------------------------------------------------ */

async function bookAppointment(args, env, ctx) {
  const name = String(args.name ?? "").trim();
  const phone = String(args.phone ?? "").replace(/\D/g, "");
  const startTime = String(args.startTime ?? "").trim();
  const isNewPatient = args.isNewPatient === true || args.isNewPatient === "true";

  if (!name) return "Missing the patient's name. Ask for it, and ask them to spell the last name.";
  if (phone.length < 10) return "The callback number looks incomplete. Ask them to repeat it.";
  const spelled = String(args.lastNameSpelling ?? "").replace(/[^a-z]/gi, "").toUpperCase();
  if (!spelled) {
    return (
      "Cannot book yet: ask the caller to spell their last name letter by " +
      "letter, read the letters back, get a yes, and pass them as " +
      "lastNameSpelling. Then ask if they'd like a text confirmation before booking."
    );
  }
  // Letters are truth: the spelled letters override the transcribed last name.
  const nameParts = name.split(/\s+/);
  const lastIdx = nameParts.length - 1;
  if (nameParts[lastIdx].toUpperCase() !== spelled) {
    nameParts[lastIdx] = spelled[0] + spelled.slice(1).toLowerCase();
  }
  const finalName = nameParts.join(" ");
  const service = resolveService(args.service);
  if (!service) return "I need to know which service they want before booking.";

  const m = startTime.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (!m) return `I need the start time as YYYY-MM-DDTHH:MM in ${SPOKEN_TZ} time.`;
  const [, date, time] = m;

  if (isNewPatient && service.requiresConsultFirst) {
    const consult = SERVICES[CONSULT_KEY];
    return (
      `New patients need a consultation before ${service.label}. ` +
      `Explain this warmly, then offer to book a ${consult.minutes}-minute ${consult.label} ` +
      `instead - call checkAvailability again with service ` +
      `"${CONSULT_KEY}", since the timing may differ.`
    );
  }

  const dayName = weekdayName(date);
  if (!isOpenDay(date)) return `Cannot book ${dayName}, ${date} - ${BUSINESS_NAME} is closed that day. We are open ${hoursSentence()}.`;
  if (date < todayLocal() || isPast(date, time)) return "That time has already passed. Ask for a later slot.";
  if (tooSoon(date, time)) {
    return `${to12Hour(time)} is too soon - same-day bookings need at least ${LEAD_MINUTES} minutes' notice. Offer a later slot.`;
  }

  const [open, close] = dayHours(date);
  const start = toMinutes(time);
  const end = start + service.minutes;
  if (start % GRID !== 0) return `Appointments start on the quarter hour. ${to12Hour(time)} isn't a valid start.`;
  if (start < open) {
    return `Cannot book ${to12Hour(time)} - ${BUSINESS_NAME} opens at ${to12Hour(fromMinutes(open))} ${SPOKEN_TZ} on ${dayName}s. Offer a later start.`;
  }
  if (end > close) {
    return (
      `Cannot book ${to12Hour(time)} - ${service.label} runs ${service.minutes} ` +
      `minutes and ${BUSINESS_NAME} closes at ${to12Hour(fromMinutes(close))} ${SPOKEN_TZ} on ${dayName}s. Offer an earlier start.`
    );
  }

  const busy = await busyIntervals(date, env);
  if (busy.some((b) => start < b.end && end > b.start)) {
    const free = openStarts(date, service.minutes, busy).slice(0, 3);
    return free.length
      ? `${to12Hour(time)} is taken. Still open: ${free.map(to12Hour).join(", ")}.`
      : `${to12Hour(time)} is taken and nothing else fits that day. Suggest another day.`;
  }

  const record = {
    name: finalName, phone,
    service: service.key,
    serviceLabel: service.label,
    date, time,
    minutes: service.minutes,
    isNewPatient,
    smsConsent: args.smsConsent === true || args.smsConsent === "true",
    createdAt: new Date().toISOString(),
  };

  await env.BOOKINGS.put(`booking:${date}:${time}`, JSON.stringify(record));

  // Calendar mirror in the background - never in the caller's hearing.
  ctx.waitUntil(
    addToCalendar(record, env).catch((e) => console.error("Calendar mirror failed", e))
  );
  if (record.smsConsent) {
    ctx.waitUntil(
      sendConfirmationSms(record, env).catch((e) => console.error("SMS failed", e))
    );
  }

  return (
    `Booked: ${finalName}, ${service.label}, ${dayName} ${date} at ${to12Hour(time)} ` +
    `${SPOKEN_TZ}, ${service.minutes} minutes. Confirm the day, time, and service ` +
    `back to the patient, mention a reminder text, then end warmly.`
  );
}

/* ------------------------------------------------------------------ */
/* Tool: urgentCallback - unconditional log, emergency tier            */
/* ------------------------------------------------------------------ */

async function urgentCallback(args, env) {
  const name = String(args.name ?? "").trim();
  const phone = String(args.phone ?? "").replace(/\D/g, "");
  const description = String(args.description ?? "").trim();

  // Log IMMEDIATELY with whatever we have - never block an escalation
  // on missing arguments. Caller ID exists on phone calls regardless.
  const key = `urgent:${Date.now()}:${phone || "unknown"}`;
  await env.BOOKINGS.put(
    key,
    JSON.stringify({ name, phone, description, createdAt: new Date().toISOString() })
  );

  const emergency = /breath|vision|blind|blurr|numb|chest|faint|swallow/i.test(description);

  const script = emergency
    ? "Say exactly: 'If you are having trouble breathing or vision changes, please hang up and call 911 or go to the emergency room right now. If you are able, I will also have a provider call you immediately.' "
    : "Say exactly: 'I'm going to have a provider call you right away. If your symptoms get worse before they reach you, please go to urgent care or call 911.' ";

  const needInfo =
    !phone
      ? "Then ask for their name and best callback number, confirm the number, "
      : "Then confirm their number, ";

  return (
    script +
    needInfo +
    "close warmly with: 'Help is on the way - a provider will call you very shortly. " +
    "Take care of yourself.' and end the call. Do not offer any assessment or advice."
  );
}

/* ------------------------------------------------------------------ */
/* Availability math                                                   */
/* ------------------------------------------------------------------ */

// Every booking that day, across all pages of the KV list.
async function busyIntervals(date, env) {
  const names = [];
  let cursor;
  do {
    const page = await env.BOOKINGS.list({ prefix: `booking:${date}:`, cursor });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const values = await Promise.all(names.map((n) => env.BOOKINGS.get(n)));
  const out = [];
  for (const v of values) {
    if (!v) continue;
    try {
      const r = JSON.parse(v);
      const s = toMinutes(r.time);
      out.push({ start: s, end: s + (r.minutes ?? 30) });
    } catch { /* skip malformed */ }
  }
  return out;
}

function openStarts(date, minutes, busy) {
  const out = [];
  const [open, close] = dayHours(date);

  for (let s = open; s + minutes <= close; s += GRID) {
    if (tooSoon(date, fromMinutes(s))) continue;
    const e = s + minutes;
    if (busy.some((b) => s < b.end && e > b.start)) continue;
    out.push(fromMinutes(s));
  }
  return out;
}

// Today, a start must be at least LEAD_MINUTES away (with 0, simply later than now).
function tooSoon(date, time) {
  if (date !== todayLocal()) return false;
  return toMinutes(time) - toMinutes(nowTimeLocal()) < Math.max(LEAD_MINUTES, 1);
}

/* ------------------------------------------------------------------ */
/* Google Calendar mirror                                              */
/* ------------------------------------------------------------------ */

let tokenCache = { token: null, expires: 0 };

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expires > now + 60) return tokenCache.token;

  const key = JSON.parse(env.GCP_SERVICE_ACCOUNT_KEY);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })
  );

  const pem = key.private_key
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(`${header}.${claim}`)
  );
  const jwt = `${header}.${claim}.${b64url(sigBuf)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  tokenCache = { token: data.access_token, expires: now + (data.expires_in ?? 3600) };
  return tokenCache.token;
}

async function addToCalendar(r, env) {
  const calendarId = env.GOOGLE_CALENDAR_ID;
  if (!calendarId) throw new Error("GOOGLE_CALENDAR_ID is not configured");

  const token = await getAccessToken(env);
  const startISO = `${r.date}T${r.time}:00`;
  const endISO = `${r.date}T${fromMinutes(toMinutes(r.time) + r.minutes)}:00`;

  const lastInitial = (r.name.split(/\s+/).slice(-1)[0] ?? "")[0] ?? "";
  const firstName = r.name.split(/\s+/)[0] ?? r.name;

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        summary: `${EVENT_PREFIX} Appointment - ${firstName} ${lastInitial}.`,
        description: `${r.serviceLabel}\n${r.name}\n${r.phone}${r.isNewPatient ? "\nNew patient" : ""}`,
        start: { dateTime: startISO, timeZone: TZ },
        end: { dateTime: endISO, timeZone: TZ },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar insert failed ${res.status}: ${body}`);
  }

  const ev = await res.json();
  const existing = JSON.parse((await env.BOOKINGS.get(`booking:${r.date}:${r.time}`)) ?? "{}");
  existing.calendarEventId = ev.id;
  await env.BOOKINGS.put(`booking:${r.date}:${r.time}`, JSON.stringify(existing));
  return ev.id;
}

/* ------------------------------------------------------------------ */
/* Time helpers (client timezone)                                      */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, "0");
const toMinutes = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMinutes = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// The SMS wording matches the registered A2P samples: keep the "Gaonkar Labs:"
// prefix and the STOP line exactly.
async function sendConfirmationSms(r, env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_MESSAGING_SERVICE_SID) {
    throw new Error("SMS not configured");
  }
  const body = new URLSearchParams({
    MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    To: `+1${r.phone}`,
    Body:
      `Gaonkar Labs: your appointment at ${BUSINESS_NAME} is confirmed for ` +
      `${r.serviceLabel} on ${weekdayName(r.date)}, ${["January","February","March","April","May","June","July","August","September","October","November","December"][Number(r.date.split("-")[1]) - 1]} ${Number(r.date.split("-")[2])} at ${to12Hour(r.time)} ${SPOKEN_TZ}. ` +
      `Reply STOP to opt out.`,
  });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );
  if (!res.ok) throw new Error(`SMS send failed ${res.status}: ${await res.text()}`);
}
function to12Hour(t) {
  let [h, m] = t.split(":").map(Number);
  const suf = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return m === 0 ? `${h} ${suf}` : `${h}:${pad(m)} ${suf}`;
}

function utcDate(date) {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayName = (date) => WEEKDAYS[utcDate(date).getUTCDay()];
const dayHours = (date) => HOURS_BY_DAY[utcDate(date).getUTCDay()];
const isOpenDay = (date) => dayHours(date) != null;

// e.g. "Monday through Friday, 9 AM to 5 PM Eastern", built from HOURS_BY_DAY.
function hoursSentence() {
  const groups = [];
  let prev = null;
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const h = HOURS_BY_DAY[d];
    const last = groups[groups.length - 1];
    if (h && last && prev === last.end && last.h[0] === h[0] && last.h[1] === h[1]) last.end = d;
    else if (h) groups.push({ start: d, end: d, h });
    prev = h ? d : null;
  }
  const parts = groups.map((g) => {
    const days = g.start === g.end ? WEEKDAYS[g.start] : `${WEEKDAYS[g.start]} through ${WEEKDAYS[g.end]}`;
    return `${days}, ${to12Hour(fromMinutes(g.h[0]))} to ${to12Hour(fromMinutes(g.h[1]))}`;
  });
  return `${parts.join("; ")} ${SPOKEN_TZ}`;
}

function sentenceList(items) {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const nowTimeLocal = () =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

const isPast = (date, time) => date === todayLocal() && time <= nowTimeLocal();

const daysOut = (date) => Math.round((utcDate(date) - utcDate(todayLocal())) / 86400000);

/* ------------------------------------------------------------------ */

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
