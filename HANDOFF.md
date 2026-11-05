# Handoff: agent-factory v0.1

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

## Done (second commit)

- `canonical.yaml` with the replace / forbidden / serviceFields shape. The
  Elevate ids (assistantId, workerUrl, knowledgeBaseFileId) are still empty:
  fill them from the dashboards before `pull-canonical`.
- `bin/factory.js`: `pull-canonical`, `new`, `build` (`--dry-run`, `--from`,
  `--yes`, `--templates`) and `test`. Build logic lives in `src/build.js`
  (steps, pre-flight, read-back checks, state.json), the smoke tests in
  `src/smoke.js`, `.env` loading in `src/env.js`.
- The live build runs a pre-flight (render everything with placeholders,
  assistant standing-rule checks, leakage over Worker / tools / KB) before
  anything is created or bought. A bought number is saved to state.json
  immediately and never bought again, even with `--from phone`.
- `templatize` also strips `server.secret` (function tools).
- `clients/example.yaml` + `example-kb.md`, fixture templates in
  `test/fixtures/templates/`, 51 node:test tests (fake Vapi / Twilio /
  Wrangler for the full build), README.

## Open items

- One-time setup (README): fill `.env`, `pull-canonical`, hand-tokenize,
  commit `templates/vapi/`. canonical.yaml ids and the Worker template are
  done (template from elevate-demo 3090ecac, verified by SHA-256; parity
  fixture `clients/elevate.yaml`, behavior tests in `test/worker.test.js`).
- Live Worker vs standing rules, not changed in the template: the auth check
  is an exact match after header cleanup (a `.includes` check was proposed),
  TWILIO_FROM_NUMBER is set but unused, and the SMS names the venue although
  the A2P samples are venue-free until the Standard/EIN brand upgrade.
- Not yet exercised against the live APIs. First real run: check how Vapi
  returns the tool secret on read (masked values only warn), the `/chat`
  response shape, and Wrangler's deploy output (URL / version parsing).
- `npm install` skipped the esbuild / workerd install scripts (npm
  allowScripts). If `wrangler deploy` complains, run
  `npm install-scripts approve esbuild workerd` and reinstall.
- Rest of the 13-test suite is still manual.

## Rules that must hold

- Secrets only come from `.env` or files, go straight into Wrangler stdin /
  API bodies, and are never printed, logged or committed.
- Never modify other builds: only create, and only touch IDs in this client's
  state.json.
- Fix the canonical first, then rebuild clients.
