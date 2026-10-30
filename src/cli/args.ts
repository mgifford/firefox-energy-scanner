/**
 * Command-line arguments: positionals, and `--flag value` pairs.
 */

export interface Args {
  _: string[];
  flags: Map<string, string[]>;
}

/**
 * Flags that never take a value. Without this, `measure --lighthouse <url>`
 * would read the URL as the flag's value and drop it from the targets.
 */
export const BOOLEAN_FLAGS = new Set([
  'authenticated', 'crux', 'crux-url', 'green-hosting', 'headed', 'headless', 'help', 'json',
  'lighthouse', 'lookup-only', 'no-energy', 'public-only', 'triage-only', 'webnrg',
  'webnrg-lookup-only',
]);

export function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--') && !BOOLEAN_FLAGS.has(key)) {
        const list = flags.get(key) ?? [];
        list.push(next);
        flags.set(key, list);
        i++;
      } else {
        flags.set(key, [...(flags.get(key) ?? []), 'true']);
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

export const one = (args: Args, key: string): string | undefined => args.flags.get(key)?.[0];
export const has = (args: Args, key: string): boolean => args.flags.has(key);
