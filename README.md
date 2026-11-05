# agent-factory

Builds a client's AI voice receptionist from one `client.yaml`: a Cloudflare
Worker (bookings, calendar mirror, SMS), the Vapi tools, knowledge base and
assistant, and a Twilio number bound to it. It automates Stages 1-4 of
[docs/demo-factory-pipeline.md](docs/demo-factory-pipeline.md) and enforces
that doc's standing rules in code: prefixed tools, gpt-4o at 0.3 set
explicitly, empty end-call phrases, a labelled number, a leakage check
against every other client's name, and a read-back after every write.

Needs Node 20+ and git.

## One-time setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in yourself: Vapi API key,
   Cloudflare API token and account id, Twilio SID and auth token, the A2P
   messaging service SID, and `GCP_KEY_FILE` (a path to the service-account
   JSON, not its contents). `.env` is gitignored. Never paste these values
   into a chat.
3. Cloudflare auth: either `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   in `.env` (token needs Workers Scripts:Edit and Workers KV Storage:Edit),
   or run `npx wrangler login` once.
4. The canonical Worker is already in `templates/worker/index.js`: the live
   elevate-demo Worker (version 3090ecac) made client-neutral. Everything
   between `// @factory:client-config:start` and `:end` (business name,
   timezone, per-day hours, lead time, consult service, SERVICES, front-desk
   list) is generated from the client.yaml. `clients/elevate.yaml` reproduces
   Elevate through it and is a test fixture only; never build it live. When
   the live Worker changes, update the template first and run `npm test`.
5. `canonical.yaml` already holds Elevate's assistant id, Worker URL and KB
   file id. Pull the canonical assistant and tools:

   ```bash
   npm run factory -- pull-canonical
   ```

   This reads (never writes) Vapi, saves raw copies to `canonical-raw/`
   (gitignored: they hold the canonical tool secret), and writes
   client-neutral templates to `templates/vapi/`. Review `git diff
   templates/`, then tokenize by hand what the literal swaps miss: the hours
   text (`{{CLIENT_HOURS}}`), the consult service line
   (`{{CONSULT_SERVICE}}`), the front-desk line (`{{FRONT_DESK_SERVICES}}`)
   and the date reference table. Commit `templates/`.

Fix the canonical first, re-pull, then rebuild clients.

## Per client

```bash
npm run factory -- new nss
```

Fill `clients/nss/client.yaml` (see `clients/example.yaml` for every field)
and `clients/nss/kb.md` from the Stage 0 research. Then:

```bash
npm run factory -- build clients/nss/client.yaml --dry-run
```

The dry run renders the Worker, wrangler.toml, every tool and the assistant
into `builds/nss/dry-run/` and runs every check with no API calls. Read the
rendered prompt once. Then the real build:

```bash
npm run factory -- build clients/nss/client.yaml --yes
```

`--yes` is required when `phone.mode` is `buy` (about $1.15/month). Steps,
in order: `phone`, `worker`, `tools`, `kb`, `assistant`, `vapi-number`.
Each records what it created in `builds/nss/state.json`; a re-run skips
finished steps and resumes a half-finished one. `--from <step>` re-runs that
step and everything after it (it creates new objects; a bought number is
always reused, never bought twice). The generated tool secret lives only in
`builds/nss/.secrets.json`.

```bash
npm run factory -- test clients/nss/client.yaml
```

Checks the Worker's `getServices` with the right and a wrong secret, then
chats with the assistant (services, a price question, a leakage sweep) and
writes `builds/nss/test-report.md`. The rest of the 13-test suite and the
live call (Stage 5) stay manual.

## Development

```bash
npm test
npm run factory -- build clients/example.yaml --dry-run --templates test/fixtures/templates
```

`test/fixtures/templates/` is a minimal stand-in for the canonical templates
so the whole pipeline can be exercised before the one-time setup.
