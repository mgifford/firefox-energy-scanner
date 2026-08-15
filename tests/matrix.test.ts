import { describe, it, expect } from 'vitest';
import { matrixSchema, baselineOf, type MatrixSpec } from '../src/cli/matrix.js';
import { interleavedOrderN } from '../src/core/stats.js';

const spec = (targets: unknown[]): MatrixSpec =>
  matrixSchema.parse({ targets });

describe('matrix schema', () => {
  it('requires at least two targets', () => {
    expect(() => spec([{ url: 'https://a.com', label: 'a' }])).toThrow();
  });

  it('rejects unknown keys rather than ignoring them', () => {
    expect(() =>
      spec([
        { url: 'https://a.com', label: 'a', typo: 1 },
        { url: 'https://b.com', label: 'b' },
      ]),
    ).toThrow();
  });

  it('rejects a non-URL target', () => {
    expect(() =>
      spec([{ url: 'nope', label: 'a' }, { url: 'https://b.com', label: 'b' }]),
    ).toThrow();
  });

  it('accepts issue and mr metadata', () => {
    const s = spec([
      { url: 'https://a.com', label: 'a', issue: '123', mr: '456', baseline: true },
      { url: 'https://b.com', label: 'b' },
    ]);
    expect(s.targets[0]?.issue).toBe('123');
    expect(s.targets[0]?.mr).toBe('456');
  });
});

describe('baselineOf', () => {
  it('returns the target marked baseline', () => {
    const s = spec([
      { url: 'https://a.com', label: 'a' },
      { url: 'https://b.com', label: 'b', baseline: true },
    ]);
    expect(baselineOf(s).label).toBe('b');
  });

  it('falls back to the first target when none is marked', () => {
    const s = spec([
      { url: 'https://a.com', label: 'a' },
      { url: 'https://b.com', label: 'b' },
    ]);
    expect(baselineOf(s).label).toBe('a');
  });
});

describe('interleavedOrderN', () => {
  const targets = ['core-head', 'patch-1', 'patch-2'];

  it('is deterministic for a given seed', () => {
    expect(interleavedOrderN(targets, 4, 's')).toEqual(interleavedOrderN(targets, 4, 's'));
  });

  it('differs across seeds', () => {
    const a = interleavedOrderN(targets, 8, 'seed-a').join(',');
    const b = interleavedOrderN(targets, 8, 'seed-b').join(',');
    expect(a).not.toBe(b);
  });

  it('runs every target exactly once per round', () => {
    const rounds = 5;
    const order = interleavedOrderN(targets, rounds, 's');
    expect(order).toHaveLength(targets.length * rounds);
    for (const t of targets) {
      expect(order.filter((x) => x === t)).toHaveLength(rounds);
    }
    // Each contiguous round contains the full target set.
    for (let r = 0; r < rounds; r++) {
      const round = order.slice(r * targets.length, (r + 1) * targets.length);
      expect(new Set(round).size).toBe(targets.length);
    }
  });

  it('never groups all runs of one target together', () => {
    const order = interleavedOrderN(['a', 'b'], 6, 's').join('');
    expect(order).not.toBe('aaaaaabbbbbb');
    expect(order).not.toBe('bbbbbbaaaaaa');
  });

  it('handles a single target and an empty list', () => {
    expect(interleavedOrderN(['only'], 3, 's')).toEqual(['only', 'only', 'only']);
    expect(interleavedOrderN([], 3, 's')).toEqual([]);
  });
});
