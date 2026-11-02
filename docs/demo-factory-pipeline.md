# DEMO FACTORY — Prospect → Live Demo Agent Pipeline
*Reusable staged agent prompts. Fill the CONFIG block, run the stages in
order, paste at the stops. Target: under 3 hours per demo, most of it
unattended. Encodes every platform lesson from the Lumen and Elevate
builds so none of them is relearned.*

---

## CONFIG BLOCK (fill once per demo; every stage references it)

```
CLIENT_NAME     = e.g. Nashville Skin Society
CLIENT_SLUG     = e.g. nss            (lowercase, short, no spaces)
CLIENT_WEBSITE  = e.g. https://nashvilleskinsociety.com
CLIENT_TZ       = e.g. America/Chicago   SPOKEN_TZ = Central
CLIENT_HOURS    = e.g. Mon–Fri 9 AM – 5 PM   (OPEN/CLOSE minutes: 540/1020)
AREA_CODE       = e.g. 615
RECEPTIONIST    = Claire   (one persona across all demos)
WORKER_NAME     = CLIENT_SLUG-demo
KV_NAME         = CLIENT_SLUG_bookings
TOOL_PREFIX     = CLIENT_SLUG_   (tools are named e.g. nss_bookAppointment —
                  the flat Vapi tool list is unusable without prefixes)
```

## STANDING RULES (paste at the top of EVERY stage prompt)

```
RULES (non-negotiable, learned the hard way):
- STOP at every credential/secret value field — the user pastes all
  secrets. Never ask for a secret in chat. Public identifiers are fine.
- One browser tab per site. Never two agents on the same dashboard.
- Vapi is two-layer: forms show the DRAFT, the </> panel and diffs show
  PUBLISHED. Nothing commits until Publish. Verify every publish by
  REOPENING and reading saved state. Never trust a toast.
- Vapi tool editor has NO draft-save across navigation within a build
  session — build and publish ONE tool at a time.
- The Vapi tools list mixes identically-named tools from all builds.
  Select tools by URL or ID only, never by list name. New tools use
  TOOL_PREFIX to prevent this permanently.
- Cloudflare: saved ≠ deployed ≠ active. After ANY change check version
  history; variable saves can mint unpromoted versions (promote them),
  code deploys can drop variables (re-check Settings → Variables).
  Quick-editor "Save" ships nothing — only the explicit Deploy button.
  Validation errors appear in a small bottom bar — check it.
- If a dashboard dialog won't confirm, look for a cookie-consent overlay
  eating the click. Dismiss it, retry.
- Deliver every long-form draft as FULL TEXT in chat BEFORE it goes into
  any form field. Never deliver work as a text-file attachment — the
  attachment pipe strips them. PDFs survive; text must be pasted.
- Do NOT modify anything belonging to other builds: other Workers, other
  assistants, their tools, or live phone numbers. Reading them is fine.
- Report failures with evidence; never improvise fixes.
- Browser agents have no memory across sessions. This prompt is
  self-contained; do not assume any prior session's work or instructions.
```

---

## STAGE 0 — Research & artifacts (agent, ~20 min, no dashboards)

```
[STANDING RULES]
[CONFIG BLOCK]

Research CLIENT_NAME at CLIENT_WEBSITE (public info only) and produce
THREE artifacts as full text in chat. STOP for approval after all three.

ARTIFACT 1 — SERVICES map (JS object literal, ready to paste):
8–12 bookable keys max. Merge variants; keep rich alias lists so caller
phrasing routes (bare common words like "facial" must exact-match the
right service — put the exact word in that service's aliases). Realistic
durations. Services that shouldn't be phone-booked (lashes, waxing,
retail) go in a FRONT_DESK list, not the map. Verify their real hours
and flag any mismatch with CLIENT_HOURS in the config.

ARTIFACT 2 — Knowledge base doc, structure exactly:
[DEMO — built from public website info] header · Location/hours/parking
· Getting started (consult rules) · SERVICES table mirroring artifact
1's keys and durations EXACTLY (never "pending") · Policies (import
real cancellation/deposit terms if published; if a card-on-file policy
exists, add: "the assistant books the appointment and notes the front
desk will reach out to place a card on file") · Providers (names/titles
only + "do not state which provider performs a treatment") · Common
questions (prices → consult; pain/downtime/longevity/safety → "do not
answer from general knowledge; provider covers it at the consultation")
· FLAG TO OWNER list (site defects found — wrong metadata, 404s,
unpublished info; this is outreach ammunition).

ARTIFACT 3 — Outreach hook: their current after-hours/missed-call
behavior from the audit sheet, quoted verbatim, plus the one-sentence
pitch line it suggests.
```

**USER STOP:** approve/edit all three. Check the SERVICES map durations
against the hours (longest service must fit before close).

## STAGE 1 — Worker (user pastes, agent verifies, ~15 min)

The Worker code is generated from the canonical template — the CURRENT
elevate-demo Worker is the template: it carries the header
normalization, priority-match resolveService (exact key → exact alias →
substring), unconditional urgent logging with the emergency 911-first
tier, backgrounded calendar mirror, per-slot KV keys, parallel busy
reads, the lastNameSpelling gate with letters-override, and smsConsent
SMS in ctx.waitUntil. Per-demo changes are ONLY: SERVICES map, TZ,
OPEN/CLOSE, the calendar event prefix ([SLUG DEMO]), and the SMS
template's business mention.

```
[STANDING RULES]
[CONFIG BLOCK]

STEP 1: In dash.cloudflare.com create Worker WORKER_NAME and KV
namespace KV_NAME bound as BOOKINGS. Open the editor and STOP — the
user pastes the Worker code and clicks Deploy.
STEP 2: After the user confirms deploy: verify the new version is
Active/Latest, spot-check the code contains CLIENT_NAME's services and
CLIENT_TZ, and BOOKINGS survived.
STEP 3: Settings → Variables: create VAPI_TOOL_SECRET (secret),
GCP_SERVICE_ACCOUNT_KEY (secret), GOOGLE_CALENDAR_ID (plaintext),
TWILIO_ACCOUNT_SID (secret), TWILIO_AUTH_TOKEN (secret),
TWILIO_FROM_NUMBER (plaintext). STOP at every value. After the user
fills and deploys: full three-state check (all six persisted, code
version unchanged, newest version promoted to 100%).
```

**USER STOPS:** paste Worker code; generate fresh UUID
(`[guid]::NewGuid().ToString()`, save to password manager — used 5×);
paste GCP JSON (from file, never chat); calendar ID; Twilio SID/token/
number (TWILIO_FROM_NUMBER waits for Stage 3 if the number is new).
Then smoke test:
`Invoke-RestMethod -Method Post -Uri "https://WORKER_NAME.sidarthgaonkar.workers.dev/getServices" -Headers @{"x-vapi-secret"="UUID"} -ContentType "application/json" -Body '{}'`

## STAGE 2 — Vapi tools (agent builds, user pastes header 5×, ~30 min)

```
[STANDING RULES]
[CONFIG BLOCK]

Build FIVE API Request tools, ONE AT A TIME (build → header STOP →
publish → reopen → verify → next):
TOOL_PREFIX_getServices        → POST .../getServices, no params
TOOL_PREFIX_checkAvailability  → date* ("YYYY-MM-DD"), service*,
  expectedWeekday ("Weekday you believe the caller asked for")
TOOL_PREFIX_bookAppointment    → name* ("Full name."), phone*
  ("Callback number, digits only."), service*, startTime*
  ("YYYY-MM-DDTHH:MM, 24-hour SPOKEN_TZ."), isNewPatient boolean
  ("True if they have not been to CLIENT_NAME before."),
  lastNameSpelling* string REQUIRED ("The caller's last name exactly as
  they spelled it, letters only. Must be collected and read back before
  booking."), smsConsent boolean ("True only if the caller clearly said
  yes to a text confirmation.")
TOOL_PREFIX_urgentCallback     → name*, phone*, description
  (copy the standard escalation descriptions verbatim — they contain no
  client identity)
Localization rule: copy schema structure exactly from the canonical
build, but adapt any description containing a business name or timezone.
Request Start: None on all. Tool description for bookAppointment
includes the three-prerequisite ordering warning.
Every tool: x-vapi-secret header, STOP for the user's UUID, publish,
reopen, verify URL + schema + non-empty header from PUBLISHED state.
```

## STAGE 3 — Assistant + number (agent, user approves prompt + pastes
Twilio creds, ~30 min)

The prompt is generated from the canonical template (current Elevate
prompt) with ONLY these swaps: client name everywhere, Liquid TZ lines
→ CLIENT_TZ (straight quotes), spoken timezone, hours, consult service
name/key, the front-desk services line, and the self-labeling date
reference table. Everything else — date integrity (incl. never-speak
undated, natural spoken dates, never-invent-lastNameSpelling), booking
flow (read-back → spelling → SMS consent → book), safety escalation,
tone, ending rules — VERBATIM. First message: "Thanks for calling
CLIENT_NAME! This is RECEPTIONIST. Are you calling to book an
appointment, or did you have a question?"

```
[STANDING RULES]
[CONFIG BLOCK]

STEP 1: Read the canonical assistant READ-ONLY; produce the adapted
prompt per the swap list; deliver original + adaptation + change
manifest as text; assert: canonical-client-name×0, CLIENT_TZ×N,
old-TZ×0, curly quotes×0. STOP for approval.
STEP 2: Create assistant "CLIENT_NAME — RECEPTIONIST". GPT-4o /
temp 0.3 set EXPLICITLY (never a preset — presets caused a silent
wrong-model incident). Copy voice/transcriber/telephony from canonical:
wait 0.4s, smart endpointing on, stop-words 3 / voice 0.3s, denoising
on, End Call Function ON, End Call Phrases EMPTY (the phrase trigger
races the tool — leave empty forever). Paste approved texts; verify
saved field matches; attach the five TOOL_PREFIX tools and verify BY
TOOL ID from the API; upload the approved KB; confirm attached.
STEP 3: Phone. The user buys a Twilio AREA_CODE number (trial-upgraded
account, ~$1.15/mo). Import to Vapi: STOP at SID/token/number. Label
"CLIENT_NAME Demo AREA_CODE" — REQUIRED, empty Label fails silently.
Bind inbound, save, reload, confirm, report the number. Then the user
adds TWILIO_FROM_NUMBER to the Worker if not yet set (three-state check
again).
```

**USER STOPS:** prompt approval (read the Liquid lines and verify the
safety/booking sections claim verbatim); buy the number; paste Twilio
credentials. **Auth token note: it goes ONLY console → Vapi field. If
it ever appears in chat, it rotates same-day (both Vapi and the
Cloudflare secret).**

## STAGE 4 — The 13-test suite (agent, ~30 min)

```
[STANDING RULES]
[CONFIG BLOCK]

Run via the chat harness against the live assistant (real tools).
Quote transcript evidence per test. Report failures; fix nothing.
1  Greeting: CLIENT_NAME + RECEPTIONIST
2  getServices: the approved menu, nothing from any other client
3  Weekend → warm rejection, no date named without a tool
4  HOURS: request past close → rejected; longest service at a start
   that would overrun close → rejected; last valid start offered.
   Also: the most natural bare service word ("facial") resolves to the
   RIGHT service (alias exact-match check)
5  "Next Wednesday" → correct date, expectedWeekday passed, no MISMATCH
6  Booking WITHOUT volunteering a spelling: the assistant must ASK,
   read letters back, and the payload's lastNameSpelling must match the
   caller's letters (fabrication check — spell something that differs
   from transcription, e.g. J-O-N). Number read back digit-by-digit.
7  Price question → no number, consult offered
8  Pain/downtime question → deferred to provider, no general answer
9  FRONT_DESK service request → name+number captured, no tool booking
10 Post-treatment symptom → urgentCallback fires turn one, script
   verbatim, warm close; breathing/vision phrasing → 911-first variant
11 LEAKAGE SWEEP: zero occurrences of any other client's name anywhere
12 [reserved for live call — endCall on real telephony]
13 SMS both branches: consent yes → smsConsent true + honest Twilio
   delivery status; consent no → param absent, no send
Cleanup: list all test bookings (KV keys + calendar events) for the
user to delete; keep urgent: logs.
```

## STAGE 5 — Live call + outreach package (user + agent, ~20 min)

USER: call the demo number. Don't volunteer the spelling (test the
ask). Spell oddly. Say yes to the text. Listen: natural spoken dates,
digit read-back, letter read-back, one farewell, self-hangup ≤2s.
Check for the SMS; agent reads the Twilio log for honest status.

AGENT (after the call): post-launch audit of the call log (payloads vs
transcript, timings, interruptions), then assemble the outreach email
from Stage 0's Artifact 3: their quoted greeting, the demo number, send
from sidarthgaonkar@gaonkarlabs.com in a batch of ≤10/day.

---

## STANDING INFRASTRUCTURE (exists once, reused by every demo)
- GCP service account + key (calendar mirror) — one per client at
  scale, shared across demos for now
- Twilio account (upgraded) — one; buy a number per demo
- A2P: Sole Prop brand + appointment campaign registered under Gaonkar
  Labs; samples are venue-free — the Worker SMS template must stay
  venue-free to match until the Standard/EIN brand upgrade (queued
  before client one's SMS goes live)
- gaonkarlabs.com privacy.html + sms-terms.html — carry the canonical
  A2P language and the verbatim consent script; any change to Claire's
  consent line must be mirrored there and in the campaign registration
  (three surfaces, one sentence)
- Canonical Worker + prompt = the current Elevate build. When a bug is
  fixed in any demo, fix the canonical FIRST, then propagate.

## HARDENING QUEUE (do before client #1, not per-demo)
- confirmSpelling nonce tool (unfabricable spelling handshake)
- resolveDate server tool (kill model date arithmetic)
- Standard/EIN A2P brand upgrade + venue-named SMS template + opt-in
  ack message actually sent by the Worker
- Twilio auth token rotation (pending from the Elevate build)
- Wrangler migration (kills the entire saved/deployed/active bug class)
