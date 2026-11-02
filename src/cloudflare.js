// Worker deploys through Wrangler, which replaces the dashboard's quick
// editor. A `wrangler deploy` creates a version and promotes it to 100% in
// one step, so the old saved / deployed / active mismatch can't happen.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function wranglerBin() {
  return join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

// Run wrangler in the build directory. `input` goes to stdin (used for
// secrets, so they never appear in argv or logs).
export function wrangler(args, { cwd, input, env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], {
      cwd,
      env: { ...env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`wrangler ${args[0]} ${args[1] ?? ''} failed (exit ${code}):\n${(stderr || stdout).slice(-1500)}`));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function wranglerToml({ workerName, kvId, vars }) {
  const lines = [
    `name = "${workerName}"`,
    'main = "src/index.js"',
    'compatibility_date = "2026-10-01"',
    'workers_dev = true',
    '',
    '[[kv_namespaces]]',
    'binding = "BOOKINGS"',
    `id = "${kvId}"`,
    '',
    '[vars]',
  ];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && v !== null && v !== '') lines.push(`${k} = ${JSON.stringify(String(v))}`);
  }
  return lines.join('\n') + '\n';
}

// Find a KV namespace by title, creating it if missing. Returns its id.
export async function ensureKvNamespace(title, opts) {
  const list = JSON.parse(await wrangler(['kv', 'namespace', 'list'], opts));
  const hit = list.find((ns) => ns.title === title);
  if (hit) return { id: hit.id, created: false };
  const out = await wrangler(['kv', 'namespace', 'create', title], opts);
  const m = /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(out);
  if (m) return { id: m[1], created: true };
  // Output format changes between Wrangler versions; fall back to listing.
  const again = JSON.parse(await wrangler(['kv', 'namespace', 'list'], opts)).find((ns) => ns.title === title);
  if (!again) throw new Error(`created KV namespace ${title} but could not find its id`);
  return { id: again.id, created: true };
}

export async function deploy(opts) {
  const out = await wrangler(['deploy'], opts);
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0];
  const version = /Current Version ID:\s*([0-9a-f-]{36})/.exec(out)?.[1];
  return { url, version, output: out };
}

export async function putSecret(name, value, opts) {
  if (!value) throw new Error(`secret ${name} has no value`);
  await wrangler(['secret', 'put', name], { ...opts, input: value });
}

export async function listSecretNames(opts) {
  const out = await wrangler(['secret', 'list', '--format', 'json'], opts);
  return JSON.parse(out).map((s) => s.name);
}
