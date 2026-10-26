import { describe, it, expect } from 'vitest';
import {
  energyCarbon,
  formatMicrograms,
  lookupGridZone,
  resolveGridIntensity,
  describeGrid,
} from '../src/core/carbon.js';
import { toHtml } from '../src/report/html.js';
import { toCsv } from '../src/report/csv.js';
import { toIndexEntry } from '../src/report/index-builder.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';

const GRID = { gramsPerKwh: 400, kind: 'average' as const, source: 'test' };

describe('energyCarbon', () => {
  it('derives micrograms with a single multiplication', () => {
    // 1 mWh = 1e-6 kWh and 1 g = 1e6 µg, so µg = mWh × gCO2e/kWh.
    const result = energyCarbon(0.0626, GRID);
    expect(result.micrograms).toBeCloseTo(25.04, 6);
    expect(result.gramsPerKwh).toBe(400);
  });

  it('keeps the sign of the energy it derives from', () => {
    expect(energyCarbon(-0.0418, GRID).micrograms).toBeCloseTo(-16.72, 6);
  });

  it('treats zero energy as zero carbon, not as missing data', () => {
    expect(energyCarbon(0, GRID).micrograms).toBe(0);
  });

  it('rejects a non-finite energy value', () => {
    expect(() => energyCarbon(Number.NaN, GRID)).toThrow(/finite number of mWh/);
  });

  it('rejects a grid intensity that cannot describe a grid', () => {
    expect(() => energyCarbon(1, { ...GRID, gramsPerKwh: 0 })).toThrow(/greater than zero/);
    expect(() => energyCarbon(1, { ...GRID, gramsPerKwh: -5 })).toThrow(/greater than zero/);
  });
});

describe('lookupGridZone', () => {
  it('resolves an alpha-2 country code', () => {
    const grid = lookupGridZone('CA')!;
    expect(grid.gramsPerKwh).toBeGreaterThan(0);
    expect(grid.kind).toBe('average');
    expect(grid.zone).toBe('CA');
    expect(grid.zoneName).toBe('Canada');
    expect(grid.year).toBeGreaterThanOrEqual(2020);
    expect(grid.source).toMatch(/Ember/);
  });

  it('resolves an alpha-3 country code and normalises it', () => {
    expect(lookupGridZone('gbr')?.zone).toBe('GBR');
  });

  it('does not invent a subnational grid', () => {
    expect(lookupGridZone('CA-ON')).toBeUndefined();
  });
});

describe('resolveGridIntensity', () => {
  it('returns undefined when nothing was declared', () => {
    expect(resolveGridIntensity({})).toBeUndefined();
  });

  it('prefers an explicit intensity and treats the zone as a label', () => {
    const grid = resolveGridIntensity({ gramsPerKwh: 30, zone: 'ca-on' })!;
    expect(grid.gramsPerKwh).toBe(30);
    expect(grid.zone).toBe('CA-ON');
    expect(grid.source).toBe('user-supplied');
  });

  it('uses the bundled table for a zone alone', () => {
    const grid = resolveGridIntensity({ zone: 'FR' })!;
    expect(grid.gramsPerKwh).toBe(lookupGridZone('FR')!.gramsPerKwh);
    expect(grid.year).toBeGreaterThanOrEqual(2020);
  });

  it('records an operator-supplied source and year', () => {
    const grid = resolveGridIntensity({
      gramsPerKwh: 120,
      source: 'IESO 2025',
      year: 2025,
      kind: 'marginal',
    })!;
    expect(grid).toMatchObject({ source: 'IESO 2025', year: 2025, kind: 'marginal' });
  });

  it('fails loudly on an unknown zone rather than dropping the column', () => {
    expect(() => resolveGridIntensity({ zone: 'ZZ-top' })).toThrow(/not in the bundled table/);
    expect(() => resolveGridIntensity({ zone: 'ZZ-top' })).toThrow(/--grid-intensity/);
  });

  it('rejects an intensity that cannot describe a grid', () => {
    expect(() => resolveGridIntensity({ gramsPerKwh: 0 })).toThrow(/greater than zero/);
  });
});

describe('formatMicrograms', () => {
  it('keeps one decimal at or above one microgram', () => {
    expect(formatMicrograms(114.34)).toBe('114.3');
  });

  it('keeps two decimals below one microgram', () => {
    expect(formatMicrograms(0.42)).toBe('0.42');
  });

  it('never renders a small non-zero value as a bare zero', () => {
    // Zero is a measurement in this project; a rounded-down value is not one.
    expect(formatMicrograms(0.004)).toBe('<0.01');
    expect(formatMicrograms(0)).toBe('0');
  });

  it('renders missing data as an em dash', () => {
    expect(formatMicrograms(undefined)).toBe('—');
  });
});

describe('describeGrid', () => {  it('names the value, the place, the kind and the source', () => {
    const grid = resolveGridIntensity({ gramsPerKwh: 400, zone: 'CA-ON', year: 2024 })!;
    const text = describeGrid(grid);
    expect(text).toContain('400 gCO2e/kWh');
    expect(text).toContain('CA-ON');
    expect(text).toContain('average intensity');
    expect(text).toContain('2024');
    expect(text).toContain('user-supplied');
  });
});

// ---------------------------------------------------------------------------
// Report gating: Class C must never publish a figure the energy cannot support.
// ---------------------------------------------------------------------------

function step(run: number, joules: number): StepResult {
  return {
    scenario: 'measure',
    step: 'https://example.com/',
    run,
    warmup: false,
    startedAt: 0,
    endedAt: 2000,
    timing: { durationMs: 2000 },
    network: { requests: 10, transferBytes: 100_000, thirdPartyRequests: 0, thirdPartyBytes: 0, byType: {} },
    co2: {
      library: '@tgwf/co2',
      libraryVersion: '0.19.0',
      model: 'swd',
      greenHosting: false,
      greenHostingChecked: false,
      inputBytes: 100_000,
      estimatedGrams: 0.0187,
    },
    energy: {
      raw: {
        durationMs: 2000,
        measurementScope: 'process',
        measurementType: 'hardware-estimate',
        attribution: 'time-window',
        adapterId: 'test',
      },
      incrementalJoules: joules,
    },
    valid: true,
    warnings: [],
  };
}

function resultFor(joules: number[], grid = true): BenchmarkResult {
  const base: BenchmarkResult = {
    schemaVersion: 1,
    session: { id: 'ses_test', startedAt: new Date(0).toISOString(), mode: 'measure' },
    environment: {
      timestamp: new Date(0).toISOString(),
      os: 'test',
      osVersion: '1',
      architecture: 'arm64',
      cpuCount: 8,
      totalMemoryBytes: 1,
      energyAdapter: 'test',
      headed: true,
      viewport: { width: 1440, height: 900 },
    },
    target: { url: 'https://example.com/' },
    configuration: {},
    scenarios: joules.map((j, i) => step(i + 1, j)),
    warnings: [],
  };
  return grid
    ? { ...base, gridIntensity: { gramsPerKwh: 400, kind: 'average', source: 'test' } }
    : base;
}

const RESOLVED = [2.0, 2.05, 2.1, 2.15, 2.2, 2.25, 2.3, 2.35, 2.4, 2.45];
const UNRESOLVED = [-0.5, -0.4, -0.3, -0.2, -0.1, 0.1, 0.2, 0.3, 0.4, 0.5];

describe('report gating for derived carbon', () => {
  it('shows the derived figure when the energy is resolvable', () => {
    const html = toHtml(resultFor(RESOLVED));
    expect(html).toContain('Client-energy CO2e (µg)');
    // median 2.225 J = 0.618 mWh × 400 g/kWh ≈ 247 µg
    expect(html).toContain('247.2');
    expect(html).toContain('Carbon derived from observed energy');
  });

  it('suppresses the figure when the energy is below its own spread', () => {
    const html = toHtml(resultFor(UNRESOLVED));
    // The column exists because an intensity was declared, but this step gets no number:
    // the final cell of the row is the carbon cell, and it is empty.
    expect(html).toContain('Client-energy CO2e (µg)');
    expect(html).toMatch(/<td>—<\/td>\s*<\/tr>/);
    expect(html).not.toMatch(/<td>-?\d+\.\d<\/td>\s*<\/tr>/);
  });

  it('omits the column entirely when no intensity was declared', () => {
    const html = toHtml(resultFor(RESOLVED, false));
    expect(html).not.toContain('Client-energy CO2e');
    expect(html).not.toContain('Carbon derived from observed energy');
  });

  it('exports the derived value and its provenance to CSV', () => {
    const csv = toCsv(resultFor(RESOLVED));
    const [header, first] = csv.trim().split('\n');
    expect(header).toContain('grid_intensity_g_per_kwh');
    expect(header).toContain('energy_co2_ug');
    const cols = header!.split(',');
    const row = first!.split(',');
    expect(row[cols.indexOf('grid_intensity_g_per_kwh')]).toBe('400');
    expect(Number(row[cols.indexOf('energy_co2_ug')])).toBeGreaterThan(200);
  });

  it('keeps the signed per-run value in CSV even where the report suppresses it', () => {
    // Deliberate: the CSV is a raw export, so the report's gating rule stays auditable.
    const csv = toCsv(resultFor(UNRESOLVED));
    const [header, ...rows] = csv.trim().split('\n');
    const col = header!.split(',').indexOf('energy_co2_ug');
    const values = rows.map((r) => Number(r.split(',')[col]));
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.min(...values)).toBeLessThan(0);
  });

  it('leaves the CSV columns empty when no intensity was declared', () => {
    const csv = toCsv(resultFor(RESOLVED, false));
    const [header, first] = csv.trim().split('\n');
    const cols = header!.split(',');
    expect(first!.split(',')[cols.indexOf('energy_co2_ug')]).toBe('');
  });

  it('publishes the derived value in the site index only alongside resolved energy', () => {
    const resolved = toIndexEntry(resultFor(RESOLVED), 'a.json');
    expect(resolved.gridIntensity?.gramsPerKwh).toBe(400);
    expect(resolved.scenarios[0]!.energyCo2Micrograms).toBeGreaterThan(200);

    const unresolved = toIndexEntry(resultFor(UNRESOLVED), 'b.json');
    expect(unresolved.scenarios[0]!.energyCo2Micrograms).toBeUndefined();
  });

  it('publishes no grid assumption when none was declared', () => {
    expect(toIndexEntry(resultFor(RESOLVED, false), 'c.json').gridIntensity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Energy spread: one sample has no IQR, and 0.000 reads as "perfectly stable".
// ---------------------------------------------------------------------------

describe('energy spread when a step was visited once', () => {
  it('renders the IQR as — rather than 0 for a single visit', () => {
    const html = toHtml(resultFor([2.0]));
    // 2.0 J = 0.556 mWh; the next cell is the IQR, which is not estimable here.
    expect(html).toMatch(/<td>0\.556<\/td>\s*<td>—<\/td>/);
    expect(html).toContain('its spread cannot be estimated');
  });

  it('still publishes the energy and the derived carbon for that visit', () => {
    // Deliberate: this is a reporting change. The resolution rule itself is
    // untouched until the single-visit question is settled.
    const html = toHtml(resultFor([2.0]));
    expect(html).toContain('222.2');
  });

  it('keeps the numeric IQR and drops the note when the step was repeated', () => {
    const html = toHtml(resultFor(RESOLVED));
    // 2.225 J = 0.618 mWh, then a real IQR to three decimals.
    expect(html).toMatch(/<td>0\.618<\/td>\s*<td>\d+\.\d{3}<\/td>/);
    expect(html).not.toContain('its spread cannot be estimated');
  });
});
