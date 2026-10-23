import { describe, it, expect } from 'vitest';
import { collectPowerUnits, energyInWindow, selectPowerUnits } from '../src/energy/gecko-profile.js';
import { ENERGY_OPTIONS, judgeEnergy, type HostFacts } from '../src/energy/probe.js';

/** One process with the named power counters, each with one 1 pWh·1e12 sample. */
const profile = (names: string[], perProcessChildren = 0) => {
  const counter = (name: string) => ({
    name,
    category: 'power',
    samples: { schema: { time: 0, count: 1 }, data: [[10, 1e12]] },
  });
  return {
    meta: { startTime: 0 },
    counters: names.map(counter),
    processes: Array.from({ length: perProcessChildren }, () => ({
      meta: { startTime: 0 },
      counters: [counter('Process Power')],
    })),
  };
};

describe('selectPowerUnits', () => {
  it('sums per-process counters on Apple Silicon', () => {
    const units = collectPowerUnits(profile(['Process Power'], 2));
    const sel = selectPowerUnits(units);
    expect(sel.scope).toBe('process');
    expect(sel.units).toHaveLength(3);
  });

  it('uses CPU package plus DRAM on Linux RAPL, not the nested domains', () => {
    // Labels exactly as Firefox's PowerCounters-linux.cpp registers them.
    const units = collectPowerUnits(
      profile(['Power: CPU cores', 'Power: CPU package', 'Power: DRAM', 'Power: iGPU']),
    );
    const sel = selectPowerUnits(units);
    expect(sel.scope).toBe('cpu-package');
    expect(sel.units.map((u) => u.name).sort()).toEqual(['Power: CPU package', 'Power: DRAM']);
    // Summing everything would have reported 4x one domain; the package and
    // DRAM do not overlap, so 2x is the right total here.
    expect(energyInWindow(sel.units, 0, 100).joules).toBeCloseTo(2 * 3600, 6);
  });

  it('prefers psys, which already contains the package', () => {
    const units = collectPowerUnits(profile(['Power: CPU package', 'Power: DRAM', 'Power: System']));
    const sel = selectPowerUnits(units);
    expect(sel.scope).toBe('system');
    expect(sel.units.map((u) => u.name)).toEqual(['Power: System']);
  });

  it('ignores per-core counters on Windows when the package is present', () => {
    const units = collectPowerUnits(
      profile(['Power: CPU package', 'Power: CPU core 0', 'Power: CPU core 1', 'Power: iGPU']),
    );
    expect(selectPowerUnits(units).units.map((u) => u.name)).toEqual(['Power: CPU package']);
  });

  it('takes the single largest counter when the labels are unrecognised', () => {
    const p = profile(['Vendor channel A', 'Vendor channel B']);
    p.counters[1]!.samples.data = [[10, 5e12]];
    const sel = selectPowerUnits(collectPowerUnits(p));
    expect(sel.units.map((u) => u.name)).toEqual(['Vendor channel B']);
    expect(sel.basis).toMatch(/not added together/);
  });
});

describe('judgeEnergy', () => {
  const linux = (over: Partial<HostFacts> = {}, rapl = { pmu: true, events: ['cores', 'pkg', 'ram'], paranoid: 0 }) =>
    ({ platform: 'linux', arch: 'x64', virtualised: false, linux: rapl, ...over }) as HostFacts;

  it('reports energy when Firefox recorded samples, whatever the platform guessed', () => {
    const j = judgeEnergy(linux(), { samples: 420, counters: ['Power: CPU package'], scope: 'cpu-package' });
    expect(j.verdict).toBe('energy');
    expect(j.reason).toMatch(/420 power samples/);
    expect(j.reason).toMatch(/whole-CPU-package/);
    expect(j.nextSteps.join(' ')).toMatch(/Close other applications/);
  });

  it('says a virtual machine cannot measure, and lists the options', () => {
    const j = judgeEnergy(
      { platform: 'linux', arch: 'x64', virtualised: true, hypervisor: 'Microsoft Corporation Virtual Machine' },
      { samples: 0, counters: [] },
    );
    expect(j.verdict).toBe('unavailable');
    expect(j.reason).toMatch(/virtual machine \(Microsoft Corporation Virtual Machine\)/);
    expect(j.nextSteps).toEqual(ENERGY_OPTIONS);
  });

  it('gives the exact fix when RAPL is present but perf_event_paranoid blocks it', () => {
    const j = judgeEnergy(linux({}, { pmu: true, events: ['pkg'], paranoid: 2 }), { samples: 0, counters: [] });
    expect(j.verdict).toBe('fixable');
    expect(j.reason).toMatch(/perf_event_paranoid is 2/);
    expect(j.nextSteps[0]).toMatch(/sudo sysctl kernel\.perf_event_paranoid=0/);
  });

  it('explains a Linux host with no RAPL events', () => {
    const j = judgeEnergy(linux({}, { pmu: false, events: [], paranoid: 0 }), { samples: 0, counters: [] });
    expect(j.verdict).toBe('unavailable');
    expect(j.reason).toMatch(/no RAPL energy events/);
  });

  it('marks a capable-looking host untested when Firefox would not start', () => {
    const j = judgeEnergy(linux(), { samples: 0, counters: [], error: 'Executable does not exist' });
    expect(j.verdict).toBe('untested');
    expect(j.nextSteps[0]).toMatch(/playwright install firefox/);
  });

  it('flags a physical Mac with no samples as unexpected rather than impossible', () => {
    const j = judgeEnergy({ platform: 'darwin', arch: 'arm64', virtualised: false }, { samples: 0, counters: ['Process Power'] });
    expect(j.verdict).toBe('unavailable');
    expect(j.reason).toMatch(/unexpected/);
  });
});
