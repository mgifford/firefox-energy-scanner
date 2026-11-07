import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * API keys, kept out of everything but the request that needs them.
 *
 * - A `.env` file in the working directory is read at startup, as dotenv
 *   does, so a key can live in a file that .gitignore keeps out of the
 *   repository. A variable already set in the environment wins.
 * - The keys named in SECRET_NAMES are then taken out of process.env and
 *   held here. Firefox, Chromium and Lighthouse are child processes and
 *   would otherwise inherit them; a page cannot read a browser's environment,
 *   but nothing that does not need a key should have one.
 * - Keys travel in request headers, never in a URL, so an error message,
 *   a proxy log or a stack trace that names the URL does not carry the key.
 */

/** Environment variables that hold credentials. */
export const SECRET_NAMES = ['CRUX_API_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const held = new Map<string, string>();

/**
 * KEY=value lines of a .env file. Comments, blank lines and `export ` are
 * allowed; values may be quoted. Pure.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = value;
  }
  return out;
}

/** Read `.env` from a directory into the environment, never overriding what is already set. Returns the names it set. */
export function loadDotEnv(dir = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const file = resolve(dir, '.env');
  if (!existsSync(file)) return [];
  const set: string[] = [];
  for (const [name, value] of Object.entries(parseDotEnv(readFileSync(file, 'utf8')))) {
    if (env[name] === undefined && value !== '') {
      env[name] = value;
      set.push(name);
    }
  }
  return set;
}

/** Take the secrets out of the environment and hold them, so no child process inherits them. */
export function holdSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_NAMES) {
    const value = env[name]?.trim();
    if (value) held.set(name, value);
    delete env[name];
  }
}

/** A held secret, or one still in the environment (tests, embedding). */
export function secret(name: SecretName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return held.get(name) ?? (env[name]?.trim() || undefined);
}

/** For tests: forget held secrets. */
export function forgetSecrets(): void {
  held.clear();
}
