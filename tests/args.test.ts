import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BOOLEAN_FLAGS, parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('reads flag values and positionals', () => {
    const a = parseArgs(['measure', 'https://a.org/', '--runs', '5', '--include', '^/a', '--include', '^/b']);
    expect(a._).toEqual(['measure', 'https://a.org/']);
    expect(a.flags.get('runs')).toEqual(['5']);
    expect(a.flags.get('include')).toEqual(['^/a', '^/b']);
  });

  it('never takes the next URL as the value of a flag that has none', () => {
    const a = parseArgs(['measure', '--crux', 'https://a.org/', '--webnrg', 'https://b.org/', '--lighthouse', 'https://c.org/']);
    expect(a._).toEqual(['measure', 'https://a.org/', 'https://b.org/', 'https://c.org/']);
  });
});

/**
 * A flag the CLI only ever checks for presence, with has(), must be listed as
 * value-less. Otherwise `measure --crux https://a.org` reads the URL as the
 * flag's value and silently drops it, which happened twice before this test.
 */
describe('value-less flags', () => {
  const source = readFileSync('src/cli/index.ts', 'utf8');
  const presence = new Set([...source.matchAll(/has\(args, '([a-z-]+)'\)/g)].map((m) => m[1]!));
  const valued = new Set([...source.matchAll(/(?:one\(args, |flags\.get\()'([a-z-]+)'/g)].map((m) => m[1]!));

  it('finds the flags to check', () => {
    expect(presence.size).toBeGreaterThan(10);
  });

  it('lists every presence-only flag in BOOLEAN_FLAGS', () => {
    const missing = [...presence].filter((f) => !valued.has(f) && !BOOLEAN_FLAGS.has(f));
    expect(missing).toEqual([]);
  });
});
