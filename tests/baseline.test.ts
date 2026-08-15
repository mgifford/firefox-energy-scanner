import { describe, it, expect } from 'vitest';
import { deriveBaseline, applyBaseline, joulesToMilliwattHours } from '../src/core/baseline.js';
import type { EnergyResult } from '../src/core/types.js';

const energy = (totalJoules: number | undefined, durationMs: number): EnergyResult => ({
  durationMs,
  ...(totalJoules !== undefined ? { totalJoules } : {}),
  measurementScope: 'process',
  measurementType: 'hardware-estimate',
  attribution: 'time-window',
  adapterId: 'test',
});

describe('deriveBaseline', () => {
  it('computes watts as joules over seconds', () => {
    const b = deriveBaseline(energy(10, 10000));
    expect(b?.watts).toBeCloseTo(1.0, 10);
  });

  it('returns undefined without energy data', () => {
    expect(deriveBaseline(energy(undefined, 1000))).toBeUndefined();
  });

  it('returns undefined for a zero-length measurement', () => {
    expect(deriveBaseline(energy(5, 0))).toBeUndefined();
  });
});

describe('applyBaseline', () => {
  it('subtracts expected idle energy and keeps all three values', () => {
    const baseline = { watts: 1, durationMs: 10000, samples: 10, adapterId: 'test' };
    const r = applyBaseline(energy(5, 2000), baseline);
    expect(r.raw.totalJoules).toBe(5);
    expect(r.estimatedIdleJoules).toBeCloseTo(2, 10); // 1 W * 2 s
    expect(r.incrementalJoules).toBeCloseTo(3, 10);
    expect(r.negativeIncremental).toBeUndefined();
  });

  it('does NOT clamp negative incremental energy, and flags it', () => {
    const baseline = { watts: 10, durationMs: 10000, samples: 10, adapterId: 'test' };
    const r = applyBaseline(energy(1, 1000), baseline);
    expect(r.incrementalJoules).toBeCloseTo(-9, 10);
    expect(r.incrementalJoules! < 0).toBe(true);
    expect(r.negativeIncremental).toBe(true);
  });

  it('passes energy through untouched when no baseline exists', () => {
    const r = applyBaseline(energy(5, 1000), undefined);
    expect(r.raw.totalJoules).toBe(5);
    expect(r.incrementalJoules).toBeUndefined();
    expect(r.estimatedIdleJoules).toBeUndefined();
  });

  it('does not invent energy when the adapter supplied none', () => {
    const baseline = { watts: 1, durationMs: 1000, samples: 1, adapterId: 'test' };
    const r = applyBaseline(energy(undefined, 1000), baseline);
    expect(r.raw.totalJoules).toBeUndefined();
    expect(r.incrementalJoules).toBeUndefined();
  });
});

describe('joulesToMilliwattHours', () => {
  it('converts using 1 mWh = 3.6 J', () => {
    expect(joulesToMilliwattHours(3.6)).toBeCloseTo(1, 10);
    expect(joulesToMilliwattHours(0)).toBe(0);
  });
});
