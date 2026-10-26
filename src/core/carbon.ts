import { GRID_ZONES } from './grid-zones.js';

/**
 * Class C: carbon derived from observed client energy.
 *
 * This is a THIRD indicator class, not a conversion of the CO2.js estimate.
 * It takes the energy actually observed on this client (Class B) and
 * multiplies it by a grid carbon intensity that the operator must declare
 * (or that comes from the bundled national-average table).
 *
 * Why this is not a CO2.js conversion:
 *
 *   - CO2.js models datacentre, network and a generic device from bytes. It
 *     answers "what might this transfer emit".
 *   - This answers "what did the electricity this browser drew emit on the
 *     grid it was plugged into". Different question, different boundary,
 *     different input.
 *
 * The result is only meaningful when the energy it derives from is itself
 * resolvable. Callers must gate on `resolution()` before publishing it; a
 * negative incremental energy would otherwise become a negative emission.
 *
 * See docs/methodology.md (Class C).
 */

export type GridIntensityKind = 'average' | 'marginal';

export interface GridIntensity {
  /** gCO2e per kWh. Must be finite and greater than zero. */
  gramsPerKwh: number;
  /** Whether this is an annual/period average or a marginal intensity. */
  kind: GridIntensityKind;
  /** Where the number came from, for audit. Never omitted. */
  source: string;
  /** Grid label as declared, e.g. "CA-ON" or "GB". */
  zone?: string;
  /** Human-readable zone name, when the bundled table supplied it. */
  zoneName?: string;
  /** Reference year of the intensity figure, when known. */
  year?: number;
}

export interface EnergyCarbon {
  /** The energy this was derived from, in milliwatt-hours. Signed. */
  milliwattHours: number;
  gramsPerKwh: number;
  /** Micrograms CO2e. Signed: negative energy yields a negative result. */
  micrograms: number;
}

/**
 * Unit identity worth knowing before reading the arithmetic:
 *
 *   1 mWh = 1e-6 kWh
 *   grams = kWh × gCO2e/kWh
 *   µg    = grams × 1e6
 *
 * so the two factors of 1e6 cancel and:
 *
 *   µg CO2e = mWh × gCO2e/kWh
 *
 * That is why the body below is a single multiplication. It is not a missing
 * unit conversion.
 */
export function energyCarbon(milliwattHours: number, grid: GridIntensity): EnergyCarbon {
  if (!Number.isFinite(milliwattHours)) {
    throw new Error(`energy must be a finite number of mWh (got ${milliwattHours})`);
  }
  if (!Number.isFinite(grid.gramsPerKwh) || grid.gramsPerKwh <= 0) {
    throw new Error(
      `grid intensity must be a finite number greater than zero (got ${grid.gramsPerKwh})`,
    );
  }
  return {
    milliwattHours,
    gramsPerKwh: grid.gramsPerKwh,
    micrograms: milliwattHours * grid.gramsPerKwh,
  };
}

/** Look up a national annual average by ISO 3166-1 alpha-2 or alpha-3 code. */
export function lookupGridZone(zone: string): GridIntensity | undefined {
  const key = zone.trim().toUpperCase();
  const direct = GRID_ZONES[key];
  const entry = direct ?? Object.values(GRID_ZONES).find((z) => z.alpha3 === key);
  if (!entry) return undefined;
  return {
    gramsPerKwh: entry.gramsPerKwh,
    kind: 'average',
    source: 'Ember via Our World in Data (national annual average)',
    zone: key,
    zoneName: entry.name,
    year: entry.year,
  };
}

export interface GridInput {
  gramsPerKwh?: number;
  zone?: string;
  kind?: GridIntensityKind;
  source?: string;
  year?: number;
}

/**
 * Turn declared inputs into a grid intensity, or undefined when nothing was
 * declared.
 *
 * An explicit intensity always wins; a zone then acts only as a label. An
 * unknown zone with no intensity is an error rather than a silent omission,
 * because the alternative is a report that quietly drops a requested column.
 */
export function resolveGridIntensity(input: GridInput): GridIntensity | undefined {
  const zone = input.zone?.trim();
  const kind = input.kind ?? 'average';

  if (input.gramsPerKwh !== undefined) {
    if (!Number.isFinite(input.gramsPerKwh) || input.gramsPerKwh <= 0) {
      throw new Error(
        '--grid-intensity must be a number greater than zero, in gCO2e per kWh ' +
          `(got "${input.gramsPerKwh}")`,
      );
    }
    const known = zone ? lookupGridZone(zone) : undefined;
    return {
      gramsPerKwh: input.gramsPerKwh,
      kind,
      source: input.source?.trim() || 'user-supplied',
      ...(zone ? { zone: zone.toUpperCase() } : {}),
      ...(known?.zoneName ? { zoneName: known.zoneName } : {}),
      ...(input.year !== undefined ? { year: input.year } : {}),
    };
  }

  if (!zone) return undefined;

  const found = lookupGridZone(zone);
  if (!found) {
    throw new Error(
      `--grid-zone "${zone}" is not in the bundled table, which holds national ` +
        'annual averages only. Subnational grids (for example CA-ON or US-CAL-CISO) ' +
        'are not included. Pass --grid-intensity with a gCO2e/kWh figure instead.',
    );
  }
  return {
    ...found,
    kind,
    ...(input.source?.trim() ? { source: input.source.trim() } : {}),
    ...(input.year !== undefined ? { year: input.year } : {}),
  };
}

/** One-line provenance string, for tables and report headers. */
export function describeGrid(grid: GridIntensity): string {
  const where = grid.zoneName && grid.zone ? `${grid.zoneName} (${grid.zone})` : grid.zone;
  const parts = [
    `${grid.gramsPerKwh} gCO2e/kWh`,
    where,
    `${grid.kind} intensity`,
    grid.year !== undefined ? `${grid.year}` : undefined,
    grid.source,
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Display formatter for Class C values.
 *
 * Never renders a small non-zero value as a bare "0": a zero is a measurement in
 * this project, and rounding 0.004 µg down to "0.0" would read as one.
 */
export function formatMicrograms(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1) return value.toFixed(1);
  if (abs >= 0.01) return value.toFixed(2);
  return value > 0 ? '<0.01' : '>−0.01';
}
