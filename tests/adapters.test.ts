import { describe, it, expect } from 'vitest';
import { NoopAdapter } from '../src/energy/noop.js';
import { parsePowermetrics, PowermetricsAdapter } from '../src/energy/powermetrics.js';
import { FirefoxProfilerAdapter, profilerLaunchEnv } from '../src/energy/firefox-profiler.js';
import { parseLabel } from '../src/core/runner.js';

describe('NoopAdapter', () => {
  it('is always available', async () => {
    expect((await new NoopAdapter().available()).available).toBe(true);
  });

  it('never reports energy values', async () => {
    const a = new NoopAdapter();
    const h = await a.start({ label: 'x' });
    const r = await a.stop(h);
    expect(r.totalJoules).toBeUndefined();
    expect(r.averageWatts).toBeUndefined();
    expect(r.cpuJoules).toBeUndefined();
    expect(r.measurementType).toBe('proxy');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('profilerLaunchEnv', () => {
  it('always requests the power feature', () => {
    const env = profilerLaunchEnv('/tmp/p.json');
    expect(env.MOZ_PROFILER_STARTUP).toBe('1');
    expect(env.MOZ_PROFILER_STARTUP_FEATURES).toContain('power');
    expect(env.MOZ_PROFILER_SHUTDOWN).toBe('/tmp/p.json');
  });

  it('merges extra features without dropping power', () => {
    const env = profilerLaunchEnv('/tmp/p.json', { features: ['cpu', 'js'] });
    const features = env.MOZ_PROFILER_STARTUP_FEATURES.split(',');
    expect(features).toContain('power');
    expect(features).toContain('cpu');
    expect(features).toContain('js');
  });

  it('does not duplicate the power feature', () => {
    const env = profilerLaunchEnv('/tmp/p.json', { features: ['power'] });
    const count = env.MOZ_PROFILER_STARTUP_FEATURES.split(',').filter((f) => f === 'power').length;
    expect(count).toBe(1);
  });
});

describe('FirefoxProfilerAdapter metadata', () => {
  it('declares process scope and a documented unit basis', () => {
    const m = new FirefoxProfilerAdapter('/tmp/x.json').metadata();
    expect(m.scope).toBe('process');
    expect(m.type).toBe('hardware-estimate');
    expect(m.unitBasis).toMatch(/picowatt-hours/);
  });

  it('reports no power data before a profile is parsed', () => {
    expect(new FirefoxProfilerAdapter('/tmp/missing.json').hasPowerData()).toBe(false);
  });

  it('returns no results when the profile file is absent', async () => {
    const a = new FirefoxProfilerAdapter('/tmp/definitely-missing-profile.json');
    await a.start({ label: 'step' });
    expect((await a.finalize()).size).toBe(0);
  });
});

/**
 * powermetrics parsing is tested against captured text so that the suite never
 * requires elevated privileges.
 */
describe('parsePowermetrics', () => {
  const SAMPLE = `
*** Sampled system activity ***

**** CPU usage ****
CPU Power: 1234.56 mW
GPU Power: 200.00 mW
Combined Power (CPU + GPU + ANE): 1500.00 mW

*** Sampled system activity ***
CPU Power: 1000.00 mW
GPU Power: 100.00 mW
Combined Power (CPU + GPU + ANE): 1200.00 mW
`;

  it('averages combined power across samples', () => {
    const r = parsePowermetrics(SAMPLE);
    expect(r.samples).toBe(2);
    expect(r.averageMilliwatts).toBeCloseTo(1350, 6);
    expect(r.cpuMilliwatts).toBeCloseTo(1117.28, 2);
    expect(r.gpuMilliwatts).toBeCloseTo(150, 6);
  });

  it('falls back to CPU+GPU when no combined line is present', () => {
    const r = parsePowermetrics('CPU Power: 500.00 mW\nGPU Power: 100.00 mW\n');
    expect(r.averageMilliwatts).toBeCloseTo(600, 6);
  });

  it('reports zero samples for unparseable text', () => {
    const r = parsePowermetrics('no power data here');
    expect(r.samples).toBe(0);
    expect(r.averageMilliwatts).toBe(0);
  });

  it('declares system scope, distinguishing it from browser-scoped energy', () => {
    expect(new PowermetricsAdapter().metadata().scope).toBe('system');
  });
});

describe('parseLabel', () => {
  it('parses warmup and measured run labels', () => {
    expect(parseLabel('run:3:open-content')).toEqual({ warmup: false, run: 3, name: 'open-content' });
    expect(parseLabel('warmup:0:open-content')).toEqual({ warmup: true, run: 0, name: 'open-content' });
  });

  it('preserves names containing colons, such as URLs', () => {
    expect(parseLabel('run:0:https://e.com/a')?.name).toBe('https://e.com/a');
  });

  it('returns undefined for internal labels', () => {
    expect(parseLabel('__baseline__')).toBeUndefined();
  });
});

/**
 * Regression: a virtualised macOS host (e.g. a GitHub-hosted runner) exposes a
 * `Process Power` counter that never emits a sample. Reporting 0 J there would
 * fabricate a measurement, so energy fields must be omitted entirely.
 */
describe('FirefoxProfilerAdapter with empty power counters', () => {
  const emptyCounterProfile = {
    meta: { startTime: 0 },
    counters: [
      {
        name: 'Process Power',
        category: 'power',
        samples: { schema: { time: 0, count: 1 }, data: [] as number[][] },
      },
    ],
  };

  it('collectPowerUnits still finds the counter', async () => {
    const { collectPowerUnits } = await import('../src/energy/gecko-profile.js');
    expect(collectPowerUnits(emptyCounterProfile)).toHaveLength(1);
  });

  it('energyInWindow reports zero samples for an empty counter', async () => {
    const { collectPowerUnits, energyInWindow } = await import('../src/energy/gecko-profile.js');
    const units = collectPowerUnits(emptyCounterProfile);
    const r = energyInWindow(units, 0, 10_000);
    expect(r.sampleCount).toBe(0);
    expect(r.joules).toBe(0);
  });

  it('a zero-sample window must not be published as 0 joules', async () => {
    // The adapter omits totalJoules when sampleCount is 0, so downstream code
    // sees "no measurement" rather than "measured zero".
    const { applyBaseline } = await import('../src/core/baseline.js');
    const noSamples = {
      durationMs: 2000,
      sampleCount: 0,
      measurementScope: 'process' as const,
      measurementType: 'hardware-estimate' as const,
      attribution: 'time-window' as const,
      adapterId: 'firefox-profiler',
    };
    const r = applyBaseline(noSamples, undefined);
    expect(r.raw.totalJoules).toBeUndefined();
    expect(r.incrementalJoules).toBeUndefined();
  });
});
