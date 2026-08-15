/**
 * Canonical data model.
 *
 * Two sustainability indicator classes are represented here and they are
 * deliberately never merged:
 *
 *   - `Co2Result`    modelled emissions estimated from transferred bytes.
 *   - `EnergyResult` observed energy drawn on the client device.
 *
 * They have different system boundaries and different units. See
 * docs/methodology.md.
 */

export const SCHEMA_VERSION = 1;

/** What the energy number physically covers. */
export type MeasurementScope =
  | 'system'
  | 'cpu-package'
  | 'process'
  | 'browser'
  | 'proxy';

/** How the energy number was obtained. */
export type MeasurementType =
  | 'hardware'
  | 'hardware-estimate'
  | 'system-estimate'
  | 'process-estimate'
  | 'proxy';

/**
 * An energy measurement for one time window.
 *
 * Optional fields are omitted entirely when the adapter cannot supply them.
 * They are never defaulted to 0, because 0 J is a measurement, not an absence.
 */
export interface EnergyResult {
  durationMs: number;

  totalJoules?: number;
  cpuJoules?: number;
  gpuJoules?: number;
  memoryJoules?: number;
  averageWatts?: number;

  firefoxCpuMs?: number;
  firefoxWakeups?: number;

  measurementScope: MeasurementScope;
  measurementType: MeasurementType;

  /**
   * How the window was attributed to the step.
   * 'time-window' means any concurrent browser activity is included.
   */
  attribution: 'time-window' | 'process-causal';

  /** Adapter that produced this result. */
  adapterId: string;

  /** Number of underlying samples integrated; low counts are unreliable. */
  sampleCount?: number;

  raw?: unknown;
}

/** Baseline-corrected view. All three values are retained, never just the delta. */
export interface EnergyWithBaseline {
  raw: EnergyResult;
  baselineWatts?: number;
  estimatedIdleJoules?: number;
  incrementalJoules?: number;
  /** True when incremental energy came out negative (measurement noise). */
  negativeIncremental?: boolean;
}

export interface ResourceEntry {
  url: string;
  domain: string;
  thirdParty: boolean;
  resourceType: string;
  transferBytes: number;
  status?: number;
  durationMs?: number;
  fromCache?: boolean;
}

export interface NetworkSummary {
  requests: number;
  transferBytes: number;
  thirdPartyRequests: number;
  thirdPartyBytes: number;
  byType: Record<string, { requests: number; bytes: number }>;
  resources?: ResourceEntry[];
}

/** Modelled emissions. Separate boundary from EnergyResult — never summed with it. */
export interface Co2Result {
  library: string;
  libraryVersion: string;
  model: string;
  greenHosting: boolean;
  greenHostingChecked: boolean;
  inputBytes: number;
  estimatedGrams: number;
  /**
   * The device-side segment of the model. This is the portion that overlaps
   * the measured client energy, exposed so the two can be compared without
   * being conflated.
   */
  consumerDeviceGrams?: number;
  networkGrams?: number;
  dataCenterGrams?: number;
}

export interface TimingResult {
  durationMs: number;
  responseMs?: number;
  domContentLoadedMs?: number;
  loadMs?: number;
  ttfbMs?: number;
  lcpMs?: number;
  cls?: number;
}

export type CacheMode = 'warm' | 'cold-context' | 'new-browser';

export interface StepResult {
  scenario: string;
  step: string;
  run: number;
  warmup: boolean;
  url?: string;
  startedAt: number;
  endedAt: number;
  timing: TimingResult;
  network?: NetworkSummary;
  co2?: Co2Result;
  energy?: EnergyWithBaseline;
  /** False when navigation failed or the measurement is not trustworthy. */
  valid: boolean;
  warnings: string[];
}

export interface EnvironmentInfo {
  timestamp: string;
  os: string;
  osVersion: string;
  architecture: string;
  cpuCount: number;
  totalMemoryBytes: number;
  machineModel?: string;
  firefoxVersion?: string;
  playwrightVersion?: string;
  co2jsVersion?: string;
  energyAdapter: string;
  headed: boolean;
  viewport: { width: number; height: number };
  onBattery?: boolean;
  batteryPercent?: number;
  /** Omitted when identifying data collection is disabled. */
  hostname?: string;
}

export interface TargetInfo {
  url: string;
  label?: string;
  commit?: string;
}

export interface SessionInfo {
  id: string;
  startedAt: string;
  endedAt?: string;
  mode: 'measure' | 'crawl' | 'journey' | 'baseline' | 'compare' | 'profile';
  /** Seed used for interleaved A/B ordering, retained for reproducibility. */
  seed?: string;
  orderings?: string[];
}

export interface BenchmarkResult {
  schemaVersion: number;
  session: SessionInfo;
  environment: EnvironmentInfo;
  target?: TargetInfo;
  targets?: TargetInfo[];
  configuration: unknown;
  /** Raw per-run measurements. Summaries never replace these. */
  scenarios: StepResult[];
  baseline?: {
    watts: number;
    durationMs: number;
    samples: number;
    adapterId: string;
  };
  warnings: string[];
}
