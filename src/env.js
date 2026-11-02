import { existsSync, readFileSync } from 'node:fs';

// Read KEY=value lines from .env into env, without overriding anything
// already set. Values are never printed.
export function loadEnv(path, env = process.env) {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
  return true;
}

// Names of required variables that are unset or empty.
export function missingEnv(names, env = process.env) {
  return names.filter((n) => !env[n]);
}
