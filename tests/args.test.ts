import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BOOLEAN_FLAGS, KNOWN_FLAGS, parseArgs, suggestFlag, unknownFlagWarnings } from '../src/cli/args.js';

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

/**
 * An option the CLI does not know is ignored, so it is warned about. The list
 * of known options must match what the code reads and the usage text documents,
 * or a real option would be warned about, or a typo would pass in silence.
 */
describe('known options', () => {
  const source = readFileSync('src/cli/index.ts', 'utf8');
  const read = new Set([...source.matchAll(/(?:one\(args, |has\(args, |intFlag\(args, |flags\.get\()'([a-z0-9-]+)'/g)].map((m) => m[1]!));
  const usage = source.slice(source.indexOf('const USAGE'), source.indexOf('`;', source.indexOf('const USAGE')));
  const documented = new Set([...usage.matchAll(/--([a-z][a-z0-9-]*[a-z0-9])\b(?!-\*)/g)].map((m) => m[1]!));

  it('includes every option the code reads', () => {
    expect(read.size).toBeGreaterThan(50);
    expect([...read].filter((f) => !KNOWN_FLAGS.has(f))).toEqual([]);
  });

  it('includes every option the usage text documents', () => {
    expect(documented.size).toBeGreaterThan(50);
    expect([...documented].filter((f) => !KNOWN_FLAGS.has(f))).toEqual([]);
  });

  it('lists nothing the code never reads', () => {
    expect([...KNOWN_FLAGS].filter((f) => !read.has(f))).toEqual([]);
  });
});

describe('unknown option warnings', () => {
  it('says nothing when every option is known', () => {
    expect(unknownFlagWarnings(parseArgs(['crawl', 'https://a.org/', '--sample', '--max-pages', '5', '--trace']))).toEqual([]);
  });

  it('names an unknown option and suggests the one meant', () => {
    expect(unknownFlagWarnings(parseArgs(['measure', 'https://a.org/', '--lighthouse-run', '5']))).toEqual([
      '--lighthouse-run is not an option, so it and the value after it ("5") were ignored. Did you mean --lighthouse-runs?',
    ]);
  });

  it('says when an unknown option swallowed the target URL', () => {
    const a = parseArgs(['crawl', '--tracee', 'https://a.org/']);
    expect(a._).toEqual(['crawl']);
    expect(unknownFlagWarnings(a)).toEqual(['--tracee is not an option, so it and the value after it ("https://a.org/") were ignored. Did you mean --trace?']);
  });

  it('points to --help when nothing is close', () => {
    expect(unknownFlagWarnings(parseArgs(['measure', '--zzzz']))).toEqual(['--zzzz is not an option, so it was ignored. Run with --help for the options.']);
  });

  it('suggests only close options', () => {
    expect(suggestFlag('max-page')).toBe('max-pages');
    expect(suggestFlag('no-energ')).toBe('no-energy');
    expect(suggestFlag('headles')).toBe('headless');
    expect(suggestFlag('lighthouse-cat')).toBe('lighthouse-categories');
    expect(suggestFlag('colour')).toBeUndefined();
  });
});

