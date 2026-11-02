# Client Integration Workflow — Any Booking Platform
*How to link a client's scheduling system to their agent as fast as possible.
Includes per-platform client instructions and browser-agent prompts.*

---

## 0. The universal architecture (never changes)

```
Caller → Vapi assistant → YOUR Worker (client-specific) → [ADAPTER] → their platform
```

Vapi always calls the same four Worker endpoints (getServices, checkAvailability,
bookAppointment, urgentCallback). Only the ADAPTER inside the Worker changes per
platform. Availability math, business-hours enforcement, weekday cross-check,
urgent escalation — all portable, all unchanged.

**Per-client, regardless of platform:**
1. Clone Worker → `<client>-medspa`, own KV namespace, fresh VAPI_TOOL_SECRET
2. Their service catalog (names, durations) into the SERVICES map
3. Their timezone into the TZ constant  ← easy to forget, ruins everything
4. Their knowledge base doc uploaded to the Vapi assistant
5. Platform credentials into Cloudflare secrets (per the doctrine: password-
   manager share link → straight into secret store → verified with reload)
6. Smoke tests → chat tests → live phone test → forwarding setup

---

## 1. Decision tree (run at discovery, on the words "what's your booking software?")

```
Their answer
├─ Boulevard ────────────────► TIER 1 · direct API · self-serve app creation
├─ Square Appointments ──────► TIER 1 · best public API of the bunch
├─ Acuity Scheduling ────────► TIER 1 · simple API key in settings
├─ Vagaro ───────────────────► TIER 1* · real API but GATED — request form,
│                               up to 7 business days approval. Start the
│                               request THE DAY the contract signs.
├─ Zenoti ───────────────────► TIER 1* · enterprise API, needs their account
│                               manager · common in larger/multi-location spas
├─ Mangomint ────────────────► TIER 1* · API exists, docs not public — email
│                               their support with the client CC'd; may
│                               require client's plan tier to include API
├─ Google Calendar only ─────► TIER 1 · you already built this (service acct)
├─ Jane / Fresha / GlossGenius / Aesthetic Record / paper book / "Karen
│  handles it" ──────────────► TIER 2 · capture-and-notify (below)
├─ Mindbody-Booker ──────────► TIER 3 · partner API program w/ fees — only
│                               worth it with 3+ prospective clients on it;
│                               otherwise Tier 2 them
└─ Anything else ────────────► Check for API docs (search "<platform> API
                                developer"). Found → Tier 1 build.
                                Not found → Tier 2. Zapier/Make lists it →
                                middleware bridge as v1.
```

`*` = gated: the credential request has lead time. These clients' onboarding
timeline starts with the API request, not the build.

**Tier 2 — capture-and-notify (the universal fallback, works for literally
any platform including paper):** agent checks availability against a mirrored
Google Calendar (front desk keeps it current — 30 seconds per booking) or
rule-based openings; takes name/number/service/preferred time; instantly
emails+SMS's the desk: "Booking request: [name], [service], [time], [phone]
— confirm in [platform]." Sold honestly as "requests confirmed by your staff
within the hour." Upgrade path to Tier 1 if their platform ever opens up.

---

## 2. Per-platform linking instructions

Each entry: what the CLIENT does (send them this), what YOU do, and the
browser-agent insert. Doctrine rules C1/C5 apply everywhere: credentials via
password-manager share link only, straight into Cloudflare secrets,
reload-verified. The client never gives you a login.

---

### 2A. BOULEVARD

**Client does (walk them through on the onboarding screen-share — it's their
dashboard login, so it's their hands on the keyboard):**
1. Go to developers.joinblvd.com and sign in with their normal Boulevard
   credentials
2. "Create new app" → fill the form (App name: "[Spa] Phone Assistant") →
   this yields an **API key** and an **App ID**
3. In the main Boulevard console: Manage Business → App & Integration →
   scroll to Custom Apps → Install → enter the App ID → this reveals the
   **app secret**
4. Business ID: My Settings → Calendar Integrations → the "Boulevard private
   calendar URL" contains it (the UUID between /businesses/ and /calendars/)
5. Send you API key + app secret + Business ID via 1Password share link

**You do:** confirm their plan includes API access (some tiers gate it — if
blocked, they ask their Boulevard CSM; usually a quick enable). Store the
three values as Cloudflare secrets. Adapter uses Boulevard's Client API
(GraphQL) for the booking flow: create cart → add bookable item → list
available times → reserve → checkout. Their sandbox lets you build before
the client's credentials even arrive. One operational gotcha: automated
bookings can't take credit cards over the phone, so the client's booking
policies must not require a card to hold automated appointments — check this
setting with them during onboarding.

**Timeline:** same-week. Sandbox build ahead of time makes it same-day.

---

### 2B. SQUARE APPOINTMENTS

**Client does:**
1. squareup.com/dashboard → Apps & Integrations → Developer tools (or
   developer.squareup.com signed into their Square account)
2. Create an application ("[Spa] Phone Assistant") → copy the **production
   access token** (this is the credential; treat like a password)
3. Send via share link, plus their Location ID (Dashboard → Locations)

**You do:** store token + location ID as secrets. Adapter uses the Square
Bookings API: SearchAvailability for open slots, CreateBooking to book.
Cleanest API in the category — availability search takes service variation +
team member + time range and returns exactly what your checkAvailability
needs. Service catalog can even be pulled live from their Catalog API instead
of hardcoded.

**Timeline:** same-day. If you build one adapter speculatively ever, make it
this one — Square is common in smaller spas and the API is self-serve.

---

### 2C. ACUITY SCHEDULING

**Client does:**
1. Acuity → Settings (gear) → Integrations → API → view credentials
2. Copy **User ID** and **API key** → send via share link

**You do:** store as secrets. Adapter uses Acuity's REST API: GET
/availability/times for slots (per appointment-type ID), POST /appointments
to book. Appointment-type IDs come from GET /appointment-types — map them to
your SERVICES keys during setup.

**Timeline:** same-day. Simplest credential flow of any platform.

---

### 2D. VAGARO  ⚠ gated — start early

**Client does (desktop only — the Developers section doesn't exist in their
mobile app, warn them):**
1. vagaro.com → Settings → scroll to Developers → APIs & Webhooks
2. First visit shows a **Contact Us** button, not credentials — API access is
   off by default on all accounts. Click it, fill the request form:
   webhooks needed = "Appointments & Customers"; use-case field = "We are
   connecting an automated phone answering and appointment booking service
   for our front desk. It will read availability and create appointments."
3. Vagaro reviews — up to seven business days
4. Once approved, the same screen shows **Client ID and Client Secret**
   (OAuth 2.0) → send via share link

**You do:** know the prerequisites before pitching the timeline — API access
requires a paid Vagaro account using their credit-card processing (not free
trial), and webhooks cost the client ~$10/month. Store credentials, build the
OAuth token exchange in the adapter, then use their appointments endpoints.
**Sequencing rule: the request form is submitted on contract-signing day**,
and the rest of onboarding (Worker clone, KB, prompt, phone tests against a
temporary Google Calendar) proceeds in parallel so the approval is the last
domino, not the first.

**Timeline:** 1–2 weeks gated on Vagaro's approval. Set the client's
expectation at signing. Offer to go live in capture-and-notify mode
immediately and hot-swap to direct booking when access lands — this turns
the wait into a demonstration.

---

### 2E. ZENOTI  ⚠ enterprise channel

**Client does:** emails their Zenoti account manager requesting API access
for a third-party integration (you draft this email for them). Zenoti issues
an API key / app credentials through that channel.

**You do:** Zenoti's API is comprehensive (it's the enterprise platform —
multi-location chains) but access runs through their partnership/account
layer, not self-serve. Once credentials arrive: availability + booking
endpoints, same adapter shape. A Zenoti spa is usually a bigger client —
worth the friction.

**Timeline:** dependent on their account manager; days to weeks. Same
parallel-onboarding + capture-and-notify bridge as Vagaro.

---

### 2F. MANGOMINT  ⚠ semi-open

**Client does:** emails Mangomint support (you draft it, client sends from
their account email, CCs you): "We're connecting an automated phone booking
assistant and need API access — what's available on our plan?"

**You do:** Mangomint has an API but documentation isn't fully public and
access can depend on plan tier (their Unlimited plan historically). Whatever
they issue — API key, scoped token — goes into secrets and the adapter gets
built against the docs they provide. If the plan blocks it, Tier 2 bridge
and revisit at renewal.

**Timeline:** unknown until support replies; bridge immediately.

---

### 2G. GOOGLE CALENDAR (or "we just use a calendar")

Already built — this is the Lumen architecture verbatim. Per-client service
account, client shares a dedicated Bookings calendar, done. Full runbook:
client-calendar-onboarding.md. **Timeline: same-day.** Also the universal
bridge layer for every gated platform above.

---

### 2H. JANE, FRESHA, GLOSSGENIUS, AESTHETIC RECORD, MINDBODY, other

No self-serve public API (or, for Mindbody, a paid partner program not worth
it below 3 clients). Tier 2 capture-and-notify:

**Client does:** creates a free Google account (or uses existing) → makes a
"Bookings — mirror" calendar → shares with your service account → front desk
mirrors real bookings onto it (or provides standing rules: "we're generally
open X, always keep Y buffer")
**You do:** Google Calendar adapter for availability; bookAppointment writes
the tentative event AND fires the desk notification (email now, SMS later
pending the outbound legal review — email is fine, it's transactional and
inbound-triggered). Sold as staff-confirmed booking.

**Timeline:** same-day. Never let a platform's closed API kill a deal — the
fallback is always available and is honestly still better than voicemail.

---

## 3. Browser-agent prompts

### 3.1 Master onboarding prompt (your side — reusable for every client)

Fill the CAPS placeholders, paste to the agent:

```
I'm onboarding a new med spa client for my AI phone assistant service.
Client: CLIENT_NAME. Platform: PLATFORM. Timezone: CLIENT_TZ.
Follow my standing rules: STOP at every credential value field — I paste all
secrets myself. Never ask me to put a secret in chat. After every save or
deploy, reload the page and confirm the value/config persisted before
moving on. Do not touch any other client's Workers, tools, or assistants —
especially anything named lumen-medspa or vapi-scheduler.

STEP 1 — Cloudflare (dash.cloudflare.com):
- Create Worker "CLIENT_SLUG-medspa". Create KV namespace
  "CLIENT_SLUG_bookings", bind as BOOKINGS.
- Open the code editor and STOP — I'll paste the Worker code (adapter
  version for PLATFORM).
- Then Settings → Variables: create VAPI_TOOL_SECRET (secret),
  PLATFORM_CREDENTIALS (secret; exact names I'll dictate per platform),
  GOOGLE_CALENDAR_ID (plaintext) if this client uses the calendar bridge.
  STOP at each value field. Deploy. Reload. Confirm all persisted.

STEP 2 — Vapi (dashboard.vapi.ai):
- Create four API Request tools named getServices, checkAvailability,
  bookAppointment, urgentCallback, POSTing to
  https://CLIENT_SLUG-medspa.<my-subdomain>.workers.dev/<toolName>.
  Same parameter schemas as the Lumen tools (copy structure, not the tools
  themselves). Request Start message: None. x-vapi-secret header on each:
  STOP at the value.
- Create assistant "CLIENT_NAME — RECEPTIONIST_NAME". Model/voice settings
  copied from Lumen Aesthetics — Ava. STOP at First Message and System
  Prompt fields — I paste both.
- Attach all four tools. Verify via the API that all four tool IDs are on
  the assistant and the prompt saved intact.
- Upload the knowledge-base file I provide to the assistant's file area.

STEP 3 — Phone:
- Create/assign a number in the client's area code AREA_CODE. Bind the
  assistant to inbound. Report the number.

STEP 4 — Verification support:
- I'll run the PowerShell smoke tests myself. Then run the chat test
  suite: weekend rejection, after-hours rejection, relative date, happy
  path, double-booking, new-patient consult gating, pricing deflection,
  and the urgent-symptom escalation (verify the urgentCallback tool fires
  and the KV log entry exists). Report each with the actual transcript
  evidence, not just pass/fail.
```

### 3.2 Client-side screen-share inserts (their dashboard = their hands)

You don't drive the client's booking-platform dashboard with your browser
agent — it's their account, their login, their liability. Instead, on the
onboarding call you screen-share and read from the "Client does" list above
while THEY click. Send the relevant per-platform steps (section 2) as a doc
before the call, same pattern as the calendar-sharing one-pager.

The browser agent CAN drive: your Cloudflare, your Vapi, your GCP, and any
sandbox/developer account you own (e.g., Boulevard sandbox, Square developer
app under your own test account) for building adapters before client
credentials arrive.

### 3.3 Post-launch verification prompt

```
Client CLIENT_NAME launched today on PLATFORM. In dashboard.vapi.ai, read
every call log for assistant "ASSISTANT_NAME" from the last 24 hours. For
each: what the caller wanted, which tools fired with what payloads, whether
the booking reached the platform/calendar (I'll cross-check the platform
side), any date/time/name discrepancies between transcript and payload, any
urgentCallback events. Flag anything where the caller could have walked away
with wrong information. Table: Call ID | Issue | Severity | Quote. Audit
only — change nothing.
```

---

## 4. Fast-path summary

| Platform | Credential lead time | Adapter effort | Live-by |
|---|---|---|---|
| Google Calendar | none | done | same day |
| Square | none | ~half day first time, then reuse | same day |
| Acuity | none | ~half day first time | same day |
| Boulevard | none–days (plan check) | ~1–2 days first time | same week |
| Vagaro | up to 7 business days | ~1 day after access | 1–2 weeks (bridge live day 1) |
| Zenoti | account-manager dependent | ~1–2 days | weeks (bridge day 1) |
| Mangomint | support-reply dependent | unknown until docs | bridge day 1 |
| No API / paper | none | done (calendar bridge) | same day |

The sentence that closes onboarding conversations regardless of platform:
"Whatever you run on, you're live within a week — direct booking if your
platform allows it, staff-confirmed booking if it doesn't, and we upgrade
in place the moment access comes through."
