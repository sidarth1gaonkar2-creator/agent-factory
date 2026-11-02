# Handoff: agent-factory v0.1 (work in progress)

Goal (roadmap phase 1): build a client's AI receptionist from one `client.yaml`
in under 30 minutes, with no dashboard clicking. Replaces the manual stages in
`docs/demo-factory-pipeline.md` (Stages 1-4). Keep every standing rule in that
doc; the code enforces them instead of a person.

## Done (in this commit)

- `src/config.js` loads and validates `client.yaml` (slug, IANA timezone, hours
  with per-day overrides, 1-12 services, aliases routed to exactly one service,
  longest service must fit every open day, phone mode buy/existing/none) and
  derives names: `<slug>-demo` Worker, `<slug>_bookings` KV, `<slug>_` tool
  prefix, `[SLUG DEMO]` event prefix, assistant name, Twilio label.
- `src/render.js` token rendering (`{{CLIENT_NAME}}` etc.; unknown tokens are an
  error), leakage check, and the Worker client block between
  `// @factory:client-config:start` and `// @factory:client-config:end`.
- `src/templatize.js` turns the raw canonical (Elevate) assistant + tools from
  the Vapi API into client-neutral templates. Strips the x-vapi-secret value and
  refuses to write if any secret survives. Literal swaps come from
  `canonical.yaml` (word-boundary safe, longest first).
- `src/vapi.js`, `src/cloudflare.js` (Wrangler wrapper: KV ensure, deploy,
  secrets via stdin), `src/twilio.js` (search/buy local number, add to A2P
  messaging service).

## Still to build

1. `canonical.yaml` (committed, no secrets): `assistantId`, `workerUrl`,
   `toolPrefix` (Elevate's, probably ""), `knowledgeBaseFileId`, `replace:` map
   of Elevate literals to tokens (business name, receptionist name, timezone,
   spoken timezone, worker name), `forbidden:` names that must never appear in
   a client build (Elevate, Lumen, Nashville Skin Society, ...),
   `worker.serviceFields` matching the canonical SERVICES shape.
2. `bin/factory.js` CLI with commands:
   - `pull-canonical`: GET assistant + each `model.toolIds` tool from Vapi,
     save raw to `canonical-raw/` (gitignored, contains the secret), run
     `templatize`, write `templates/vapi/assistant.json` and
     `templates/vapi/tools/*.json`, print the replacement counts and any leaks.
     Human reviews the diff once and hand-tokenizes what literal swaps miss
     (hours text, consult service line, front-desk line, date table).
   - `new <slug>`: copy `clients/example.yaml` to `clients/<slug>/client.yaml`
     plus an empty `kb.md`.
   - `build <client.yaml> [--dry-run] [--from <step>] [--yes]`, steps in order,
     each recording created IDs in `builds/<slug>/state.json` so re-runs skip
     finished steps:
     1. phone: buy a local number in the area code (`--yes` required, it costs
        money) or use the existing one; add to TWILIO_MESSAGING_SERVICE_SID.
     2. worker: render `templates/worker/index.js` into
        `builds/<slug>/src/index.js`, write wrangler.toml, ensure KV, deploy,
        then put secrets: VAPI_TOOL_SECRET (generated with
        crypto.randomUUID, saved only in `builds/<slug>/.secrets.json` mode
        0600), GCP_SERVICE_ACCOUNT_KEY (from GCP_KEY_FILE), TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN. Vars: GOOGLE_CALENDAR_ID, TWILIO_FROM_NUMBER,
        TWILIO_MESSAGING_SERVICE_SID. Verify with `wrangler secret list`.
     3. tools: render each tool template with WORKER_URL + VAPI_TOOL_SECRET,
        create, read back by ID, check name/url/secret header.
     4. kb: upload `knowledgeBase` file, keep its id as KB_FILE_ID.
     5. assistant: render, set `model.toolIds` to the new IDs, assert
        gpt-4o / temperature 0.3 set explicitly and endCallPhrases empty, run
        the leakage check, create, read back and compare prompt + toolIds.
     6. vapi-number: import the Twilio number to Vapi bound to the assistant,
        Label = derived phoneLabel (empty label fails silently), read back.
     `--dry-run` renders everything into `builds/<slug>/` with no API calls.
   - `test <client.yaml>`: POST the Worker's getServices with the secret (200,
     every service key present, no forbidden names), with a wrong secret
     (must be rejected); then Vapi `POST /chat` scripted turns (services ask,
     price question, leakage sweep) into `builds/<slug>/test-report.md`. The
     rest of the 13-test suite stays manual for now.
3. Unit tests in `test/` (node:test) for config validation, render,
   templatize (secret stripping, word boundaries), workerConfigBlock.
4. README: one-time setup (.env from .env.example, copy the elevate-demo
   Worker code from the Cloudflare dashboard into `templates/worker/index.js`
   and wrap its client constants in the markers, `npx wrangler login` or
   CLOUDFLARE_API_TOKEN, run `pull-canonical`), then per client:
   `new` -> fill yaml + kb -> `build --dry-run` -> `build` -> `test` -> live
   call (Stage 5 stays human).

## Rules that must hold

- Secrets only come from `.env` or files, go straight into Wrangler stdin /
  API bodies, and are never printed, logged or committed.
- Never modify other builds: only create, and only touch IDs in this client's
  state.json.
- Fix the canonical first, then rebuild clients.
