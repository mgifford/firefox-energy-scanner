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
  'adaptive', 'authenticated', 'dry-run', 'crux', 'crux-url', 'green-hosting', 'headed', 'headless', 'help', 'json',
  'crux-pages', 'lighthouse', 'lookup-only', 'no-energy', 'no-history', 'no-key-pages', 'popular', 'public-only', 'sample', 'trace', 'triage-only', 'webnrg',
  'webnrg-lookup-only', 'write',
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

/**
 * Every option the CLI reads. An option not in this list is ignored, so it is
 * warned about: a mistyped option, or one from a newer version, otherwise does
 * nothing and says nothing. tests/args.test.ts keeps this list in step with
 * the options the code reads and the usage text documents.
 */
export const KNOWN_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  'a', 'also', 'also-file', 'b', 'block-url', 'config', 'crux-form-factor', 'crux-key', 'crux-max', 'dir', 'exclude', 'file', 'from',
  'grid-intensity', 'grid-kind', 'grid-source', 'grid-year', 'grid-zone', 'host', 'idle', 'include', 'item', 'journey',
  'keep-eager', 'kind', 'label-a', 'label-b', 'lighthouse-categories', 'lighthouse-form-factor', 'lighthouse-reports',
  'lighthouse-runs', 'lighthouse-top', 'markdown', 'max-depth', 'max-pages', 'name', 'out', 'path', 'previous', 'runs',
  'save-spec', 'seed', 'selector', 'spec', 'title-file', 'trace-idle', 'trace-keep', 'trace-max-mb',
  'trace-pages', 'url', 'viewport', 'wait', 'warmups', 'webnrg-top', 'webnrg-wait',
]);

/** Edit distance, for suggesting the option someone meant. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The known option closest to a mistyped one, when one is close. */
export function suggestFlag(flag: string, known: Iterable<string> = KNOWN_FLAGS): string | undefined {
  let best: { k: string; d: number } | undefined;
  for (const k of known) {
    // The start of an option cut short (--lighthouse-cat) ranks first; then a few edits away.
    const prefix = flag.length >= 4 && k.startsWith(flag) && k.length - flag.length <= 8;
    const edits = distance(flag, k);
    const d = prefix ? 0.5 : edits;
    if ((prefix || edits <= Math.max(1, Math.floor(flag.length / 5))) && (!best || d < best.d || (d === best.d && k.length < best.k.length))) best = { k, d };
  }
  return best?.k;
}

/**
 * One warning per option the CLI does not know. An unknown option takes the
 * next word as its value, so the warning says what else was ignored: often
 * the URL meant as the command's target.
 */
export function unknownFlagWarnings(args: Args, known: Set<string> = KNOWN_FLAGS): string[] {
  const out: string[] = [];
  for (const [flag, values] of args.flags) {
    if (known.has(flag)) continue;
    const swallowed = values.filter((v) => v !== 'true');
    const hint = suggestFlag(flag, known);
    out.push(
      `--${flag} is not an option, so it ${swallowed.length ? `and the value after it (${swallowed.map((v) => `"${v}"`).join(', ')}) were` : 'was'} ignored.` +
        (hint ? ` Did you mean --${hint}?` : ' Run with --help for the options.'),
    );
  }
  return out;
}

