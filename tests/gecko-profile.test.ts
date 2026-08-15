import { describe, it, expect } from 'vitest';
import {
  pwhToJoules,
  collectPowerUnits,
  energyInWindow,
} from '../src/energy/gecko-profile.js';

describe('pwhToJoules', () => {
  it('applies the documented pWh -> Wh -> J conversion', () => {
    // 1 Wh = 1e12 pWh = 3600 J
    expect(pwhToJoules(1e12)).toBeCloseTo(3600, 6);
  });

  it('is zero for zero energy', () => {
    expect(pwhToJoules(0)).toBe(0);
  });
});

const counter = (startTime: number, rows: number[][]) => ({
  meta: { startTime },
  counters: [
    {
      name: 'Process Power',
      category: 'power',
      samples: { schema: { time: 0, count: 1 }, data: rows },
    },
  ],
});

describe('collectPowerUnits', () => {
  it('collects power counters from parent and content processes', () => {
    const profile = {
      ...counter(1000, [[10, 5]]),
      processes: [counter(1500, [[10, 7]]), counter(1200, [[10, 9]])],
    };
    const units = collectPowerUnits(profile);
    expect(units).toHaveLength(3);
    expect(units.map((u) => u.processStartTime).sort()).toEqual([1000, 1200, 1500]);
  });

  it('ignores non-power counters', () => {
    const profile = {
      meta: { startTime: 0 },
      counters: [
        { name: 'memory', category: 'Memory', samples: { schema: { time: 0, count: 1 }, data: [[1, 1]] } },
      ],
    };
    expect(collectPowerUnits(profile)).toHaveLength(0);
  });

  it('tolerates a profile with no counters at all', () => {
    expect(collectPowerUnits({ meta: { startTime: 0 } })).toHaveLength(0);
    expect(collectPowerUnits(undefined)).toHaveLength(0);
  });
});

describe('energyInWindow', () => {
  it('sums only samples inside the window', () => {
    // Process starts at epoch 1000. Samples at epoch 1010,1020,1030.
    const units = collectPowerUnits(counter(1000, [[10, 1e12], [20, 1e12], [30, 1e12]]));
    // Window (1005, 1025] captures the samples at 1010 and 1020 => 2 Wh => 7200 J
    const r = energyInWindow(units, 1005, 1025);
    expect(r.sampleCount).toBe(2);
    expect(r.joules).toBeCloseTo(7200, 6);
  });

  it('uses a half-open window so adjacent steps do not double count', () => {
    const units = collectPowerUnits(counter(0, [[10, 1e12]]));
    const first = energyInWindow(units, 0, 10);   // includes t=10
    const second = energyInWindow(units, 10, 20); // must not re-include t=10
    expect(first.sampleCount).toBe(1);
    expect(second.sampleCount).toBe(0);
  });

  /**
   * Regression test for the defect found during validation: summing only the
   * parent process omitted the content process where page JS runs, and each
   * process uses its own time origin. See docs/decision-record.md TDR-003.
   */
  it('normalises per-process time origins and includes content processes', () => {
    const profile = {
      // Parent starts at epoch 1000; sample at rel 100 => epoch 1100.
      ...counter(1000, [[100, 1e12]]),
      processes: [
        // Content starts at epoch 1500; sample at rel 100 => epoch 1600.
        counter(1500, [[100, 2e12]]),
      ],
    };
    const units = collectPowerUnits(profile);

    // Window covering ONLY the parent sample (epoch 1050..1150).
    const parentOnly = energyInWindow(units, 1050, 1150);
    expect(parentOnly.sampleCount).toBe(1);
    expect(parentOnly.joules).toBeCloseTo(3600, 6);

    // Window covering ONLY the content sample (epoch 1550..1650).
    const contentOnly = energyInWindow(units, 1550, 1650);
    expect(contentOnly.sampleCount).toBe(1);
    expect(contentOnly.joules).toBeCloseTo(7200, 6);

    // A naive implementation that ignored per-process origins would treat both
    // samples as being at the same relative time and mis-bucket them.
    const both = energyInWindow(units, 1000, 1700);
    expect(both.sampleCount).toBe(2);
    expect(both.joules).toBeCloseTo(10800, 6);
  });

  it('returns zero energy for a window with no samples', () => {
    const units = collectPowerUnits(counter(0, [[10, 1e12]]));
    const r = energyInWindow(units, 100, 200);
    expect(r.sampleCount).toBe(0);
    expect(r.joules).toBe(0);
  });
});
