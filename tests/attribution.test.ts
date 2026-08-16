import { describe, it, expect } from 'vitest';
import { attributeCpuTime, attributeEnergy } from '../src/energy/attribution.js';

/** Minimal profile: category lives on the frame table, as Gecko emits it. */
const profile = (rows: (number | null)[][], withCpu = true) => ({
  meta: {
    startTime: 0,
    categories: [{ name: 'Idle' }, { name: 'Other' }, { name: 'Layout' }, { name: 'JavaScript' }],
  },
  threads: [
    {
      name: 'GeckoMain',
      samples: {
        schema: withCpu
          ? { stack: 0, time: 1, threadCPUDelta: 2 }
          : { stack: 0, time: 1 },
        data: rows,
      },
      // stack i -> frame i
      stackTable: { schema: { prefix: 0, frame: 1 }, data: [[null, 0], [null, 1], [null, 2], [null, 3]] },
      frameTable: {
        schema: { location: 0, category: 1 },
        data: [[0, 0], [1, 1], [2, 2], [3, 3]],
      },
    },
  ],
});

describe('attributeCpuTime', () => {
  it('sums CPU time per category', () => {
    // stack 2 = Layout, stack 3 = JavaScript; CPU in microseconds
    const r = attributeCpuTime(profile([[2, 10, 4000], [3, 20, 6000]]), 0, 100);
    expect(r.basis).toBe('cpu-time');
    expect(r.byCategory.get('Layout')).toBeCloseTo(4, 6);
    expect(r.byCategory.get('JavaScript')).toBeCloseTo(6, 6);
    expect(r.totalCpuMs).toBeCloseTo(10, 6);
  });

  it('excludes Idle time so it cannot dilute the shares', () => {
    const r = attributeCpuTime(profile([[0, 10, 9000], [2, 20, 1000]]), 0, 100);
    expect(r.byCategory.has('Idle')).toBe(false);
    expect(r.totalCpuMs).toBeCloseTo(1, 6);
  });

  it('respects the time window', () => {
    const r = attributeCpuTime(profile([[2, 10, 1000], [2, 500, 1000]]), 0, 100);
    expect(r.sampleCount).toBe(1);
  });

  /**
   * Regression: without the profiler's `cpu` feature, sample rows are
   * truncated and carry no threadCPUDelta. Returning nothing would look like
   * "no work happened"; falling back to sample counts is coarser but honest.
   */
  it('falls back to sample counts when CPU time is absent', () => {
    const r = attributeCpuTime(profile([[2, 10], [3, 20], [3, 30]], false), 0, 100);
    expect(r.basis).toBe('sample-count');
    expect(r.sampleCount).toBe(3);
    expect(r.byCategory.get('JavaScript')).toBe(2);
    expect(r.byCategory.get('Layout')).toBe(1);
  });

  it('handles a profile with no threads', () => {
    const r = attributeCpuTime({ meta: { startTime: 0 } }, 0, 100);
    expect(r.sampleCount).toBe(0);
    expect(r.totalCpuMs).toBe(0);
  });
});

describe('attributeEnergy', () => {
  it('apportions energy in proportion to CPU share', () => {
    const r = attributeEnergy(profile([[2, 10, 2500], [3, 20, 7500]]), 0, 100, 4);
    const layout = r.categories.find((c) => c.category === 'Layout')!;
    const js = r.categories.find((c) => c.category === 'JavaScript')!;
    expect(layout.share).toBeCloseTo(0.25, 6);
    expect(js.share).toBeCloseTo(0.75, 6);
    expect(layout.apportionedJoules).toBeCloseTo(1, 6);
    expect(js.apportionedJoules).toBeCloseTo(3, 6);
  });

  it('sorts categories by cost, heaviest first', () => {
    const r = attributeEnergy(profile([[2, 10, 1000], [3, 20, 9000]]), 0, 100, 1);
    expect(r.categories[0]?.category).toBe('JavaScript');
  });

  it('omits apportioned joules when no energy was measured', () => {
    const r = attributeEnergy(profile([[2, 10, 1000]]), 0, 100, undefined);
    expect(r.categories[0]?.apportionedJoules).toBeUndefined();
    expect(r.measuredJoules).toBeUndefined();
  });

  it('always states the apportionment assumption', () => {
    const r = attributeEnergy(profile([[2, 10, 1000]]), 0, 100, 1);
    expect(r.method).toBe('cpu-time-apportioned');
    expect(r.assumption).toMatch(/apportioned/i);
    expect(r.assumption).toMatch(/not per-category measurements/i);
  });

  it('warns in the assumption when falling back to sample counts', () => {
    const r = attributeEnergy(profile([[2, 10]], false), 0, 100, 1);
    expect(r.assumption).toMatch(/CPU time was unavailable/i);
  });
});
