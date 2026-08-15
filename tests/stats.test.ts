import { describe, it, expect } from 'vitest';
import {
  summarize,
  median,
  percentile,
  spearman,
  compare,
  interleavedOrder,
  resolution,
} from '../src/core/stats.js';

describe('percentile / median', () => {
  it('computes the median of odd and even length sets', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('handles a single value', () => {
    expect(median([7])).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('returns NaN for an empty set', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('summarize', () => {
  it('reports the full descriptive set', () => {
    const s = summarize([1, 2, 3, 4, 5]);
    expect(s.count).toBe(5);
    expect(s.median).toBe(3);
    expect(s.mean).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.p25).toBe(2);
    expect(s.p75).toBe(4);
    expect(s.iqr).toBe(2);
    // sample standard deviation (n-1) of 1..5 is sqrt(2.5)
    expect(s.stdDev).toBeCloseTo(Math.sqrt(2.5), 10);
  });

  it('ignores non-finite values', () => {
    expect(summarize([1, Number.NaN, 3]).count).toBe(2);
  });

  it('returns a zero count for no data', () => {
    expect(summarize([]).count).toBe(0);
  });
});

describe('spearman', () => {
  it('is 1 for a perfectly monotonic increasing relationship', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it('is -1 for a perfectly monotonic decreasing relationship', () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('detects monotonic but non-linear relationships', () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 10);
  });

  it('returns NaN with too few points', () => {
    expect(Number.isNaN(spearman([1, 2], [1, 2]))).toBe(true);
  });
});

describe('compare', () => {
  it('reports a negative percent difference when b is lower', () => {
    const a = Array.from({ length: 12 }, () => 10);
    const b = Array.from({ length: 12 }, () => 8);
    const r = compare(a, b);
    expect(r.medianDifference).toBe(-2);
    expect(r.percentDifference).toBeCloseTo(-20, 10);
    expect(r.sufficientSamples).toBe(true);
    expect(r.qualification).toBeUndefined();
  });

  it('qualifies results from small samples rather than claiming significance', () => {
    const r = compare([10, 10, 10], [8, 8, 8]);
    expect(r.sufficientSamples).toBe(false);
    expect(r.qualification).toMatch(/indicative only/i);
  });
});

describe('interleavedOrder', () => {
  it('is deterministic for a given seed', () => {
    expect(interleavedOrder(5, 'seed-1')).toEqual(interleavedOrder(5, 'seed-1'));
  });

  it('differs across seeds', () => {
    const a = interleavedOrder(20, 'seed-1').join('');
    const b = interleavedOrder(20, 'seed-2').join('');
    expect(a).not.toBe(b);
  });

  it('balances a and b exactly', () => {
    const order = interleavedOrder(10, 'x');
    expect(order).toHaveLength(20);
    expect(order.filter((v) => v === 'a')).toHaveLength(10);
    expect(order.filter((v) => v === 'b')).toHaveLength(10);
  });

  it('never groups all of one target before the other', () => {
    const order = interleavedOrder(10, 'x').join('');
    expect(order).not.toBe('a'.repeat(10) + 'b'.repeat(10));
    expect(order).not.toBe('b'.repeat(10) + 'a'.repeat(10));
  });
});

describe('resolution', () => {
  it('resolves an effect larger than its own spread', () => {
    const r = resolution([1.0, 1.05, 0.95, 1.02, 0.98]);
    expect(r.resolved).toBe(true);
    expect(r.note).toBeUndefined();
  });

  it('does not resolve an effect smaller than its spread', () => {
    // median ~0.01, IQR ~1.0
    const r = resolution([-0.5, 0.01, 0.5, -0.4, 0.45]);
    expect(r.resolved).toBe(false);
    expect(r.note).toMatch(/smaller than the run-to-run spread/);
  });

  /**
   * A tight cluster below the idle baseline is still unresolvable: the
   * workload did not measurably exceed idle, however consistent the readings.
   */
  it('does not resolve a consistently negative median', () => {
    const r = resolution([-0.009, -0.0091, -0.0089, -0.0092, -0.0088]);
    expect(r.resolved).toBe(false);
    expect(r.note).toMatch(/at or below zero/);
  });

  it('does not resolve a zero median', () => {
    expect(resolution([0, 0, 0]).resolved).toBe(false);
  });

  it('does not resolve an empty set', () => {
    const r = resolution([]);
    expect(r.resolved).toBe(false);
    expect(r.note).toMatch(/No energy measurements/);
  });

  it('resolves a positive median with zero spread', () => {
    expect(resolution([2, 2, 2]).resolved).toBe(true);
  });
});
