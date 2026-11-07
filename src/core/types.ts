import type { GridIntensity } from './carbon.js';

/**
 * Canonical data model.
 *
 * Three sustainability indicator classes are represented here and they are
 * deliberately never merged:
 *
 *   - `Co2Result`     modelled emissions estimated from transferred bytes.
 *   - `EnergyResult`  observed energy drawn on the client device.
 *   - `gridIntensity` the declared grid assumption behind Class C, the carbon
 *                     derived from that observed energy. Only the assumption
 *                     is stored; the derived figure is computed at report
 *                     time so the raw measurements stay the source of truth.
 *
 * They have different system boundaries and different units. See
 * docs/methodology.md.
 */

/**
 * 2: adds the component graph (`graph`). Version 1 results are read through
 * migrateResult (src/model/migrate.ts), which derives it from stored data.
 */
export const SCHEMA_VERSION = 2;

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
  /** True when every byte came from a domain listed as green-hosted. */
  greenHosting: boolean;
  greenHostingChecked: boolean;
  /**
   * Bytes from domains the Green Web Foundation lists as green-hosted, when
   * checked per domain. The model zeroes data-centre operational emissions
   * for these; the rest, unknown domains included, count as grid-powered.
   */
  greenBytes?: number;
  /** Bytes from domains whose hosting could not be checked (modelled as grid-powered). */
  greenUnknownBytes?: number;
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

/** Structural snapshot of the page, independent of any power hardware. */
export interface AnatomySummary {
  domNodes: number;
  domDepth: number;
  cssRules: number;
  cssSelectors: number;
  scripts: number;
  images: number;
  iframes: number;
  animatedElements: number;
  heaviestSubtrees?: { selector: string; nodes: number }[];
  lcpElement?: { selector: string; renderTimeMs: number; sizePx: number };
  /**
   * Landmarks, component signatures, frameworks and Drupal hints, used to
   * group pages into families. Absent in results made before it existed.
   */
  structure?: import('../collect/page-anatomy.js').PageStructure;
}

export interface FindingSummary {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
  action: string;
  category: string;
}

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
  /** Page structure. Available on every host, energy or not. */
  anatomy?: AnatomySummary;
  findings?: FindingSummary[];
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
  /** The CPU's name as the OS reports it, such as "Apple M2 Pro". */
  cpuModel?: string;
  /** Node ran under Rosetta 2 on an Apple Silicon Mac (Firefox may still be native). */
  rosetta?: boolean;
  firefoxVersion?: string;
  playwrightVersion?: string;
  co2jsVersion?: string;
  energyAdapter: string;
  headed: boolean;
  viewport: { width: number; height: number };
  onBattery?: boolean;
  batteryPercent?: number;
  /** macOS Low Power Mode throttles the CPU and suppresses measured energy. */
  lowPowerMode?: boolean;
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

/** How a crawl chose its pages, so a reader knows what the sample stands for. */
export interface CrawlSampling {
  /**
   * sitemap: a seeded random sample of the sitemap's pages (the default with
   * --sample). adaptive: a seeded sample spread across the site's URL
   * sections, with rare sections kept as possible outliers. links: pages
   * found by following links from the start page.
   */
  method: 'sitemap' | 'adaptive' | 'links';
  /** The sitemap the pages came from. */
  source?: string;
  /** Scannable pages the sitemap listed. */
  listed?: number;
  /** Pages chosen, the start page included. */
  picked: number;
  /** Of those, pages the requester listed (after the start page). */
  requested?: number;
  /**
   * Adaptive samples only: the URL sections the listed pages fall into, how
   * many pages each holds and how many were picked from it.
   */
  strata?: { section: string; sitemap?: string; listed: number; picked: number; rare: boolean }[];
  /** Strata the listed pages fell into; only the largest and those picked from are kept above. */
  strataTotal?: number;
  /** Why each picked page was chosen, by URL. */
  reasons?: Record<string, SampleReason>;
  /**
   * How a sitemap sample was ordered: url-hash, where each page's place
   * depends only on the page, so re-scans keep most of their pages. Absent
   * in older results, which used a seeded shuffle.
   */
  order?: 'url-hash';
  /** Child sitemaps read, and how many an index named, when it was an index. */
  sitemapsRead?: number;
  sitemapsListed?: number;
  /**
   * URLs skipped because they are not HTML pages (PDFs, spreadsheets,
   * archives), found from the extension or the served Content-Type before
   * Firefox visited them. They do not count against the page limit; a sample
   * replaced them. At most 50 are listed; notHtmlCount counts them all.
   */
  notHtml?: { url: string; contentType?: string }[];
  notHtmlCount?: number;
  /** Key pages measured, found from the start page. */
  keyPages?: { kind: 'search' | 'contact' | 'accessibility' | 'not-found'; url: string; from: string }[];
  /** URLs skipped because the server said they are not there (404, 410). At most 50. */
  gone?: { url: string; status?: number }[];
  /** What checking the sample's URLs found. */
  health?: SampleHealth;
  /**
   * What the sitemap said about the eligible pages: translations set aside
   * (one per hreflang group is eligible), pages marked with video or images,
   * and the range of last-modified dates.
   */
  sitemapMeta?: { translationsSetAside?: number; videoPages?: number; imagePages?: number; dated?: number; oldest?: string; newest?: string };
  /** What the sample cannot stand for. Plain sentences, shown as given. */
  limitations?: string[];
}

export type SampleReason = 'start' | 'requested' | 'key-page' | 'random' | 'representative' | 'proportional' | 'rare-section' | 'video-page' | 'legacy-page' | 'linked';

/** What checking a sample's URLs found, before Firefox visited any. */
export interface SampleHealth {
  /** URLs checked. */
  checked: number;
  /** HTML pages. */
  html: number;
  /** Files: PDFs, spreadsheets, archives. Replaced. */
  files: number;
  /** Not there: 404 or 410. Replaced. */
  gone: number;
  /** Redirected somewhere else. */
  redirected: number;
  /** Redirected to a page already in the sample. Replaced. */
  duplicates: number;
  /** Redirected to another site. Replaced. */
  offSite: number;
  /** Could not be checked, so kept. */
  unknown: number;
}

/**
 * Pages that share a structure, grouped after a scan. Built from what each
 * page's anatomy recorded: landmarks, component signatures, scripts and
 * stylesheets, URL pattern and Drupal template hints. A family is a grouping
 * for investigation, not a measurement; its figures are medians of the pages
 * measured in it, never extrapolated to pages that were not.
 */
export type { PageFamily, FamilyReport } from '../analysis/families.js';

export interface BenchmarkResult {
  schemaVersion: number;
  /** Set when an older result was migrated: the version it was written with. */
  migratedFrom?: number;
  session: SessionInfo;
  environment: EnvironmentInfo;
  /**
   * What this host could and could not measure. Declared explicitly so an
   * absent energy figure is never mistaken for a measured zero.
   */
  capabilities?: {
    tier: 'full' | 'structural';
    summary: string;
    unavailable: { metric: string; reason: string }[];
    /** Why energy was or was not measured on this host, and what would change it. */
    energyCheck?: {
      verdict: 'energy' | 'fixable' | 'unavailable' | 'untested';
      reason: string;
      nextSteps: string[];
      hypervisor?: string;
      scope?: 'process' | 'cpu-package' | 'system';
    };
  };
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
  /**
   * The grid assumption used to derive Class C carbon from observed energy.
   * Absent means no intensity was declared, so no derived figure is reported.
   */
  gridIntensity?: GridIntensity;
  /**
   * Lighthouse lab results, when requested. A separate indicator with its own
   * boundary — Chromium under simulated throttling — kept beside the Firefox
   * measurements and never combined with them.
   */
  lighthouse?: import('../lighthouse/summary.js').LighthouseSummary;
  /**
   * CrUX field data, when requested. Real-user percentiles from a trailing
   * 28-day window: a different population from the Lighthouse lab run, reported
   * beside it and never combined with it, with energy, or with CO2.js.
   */
  crux?: import('../core/crux.js').CruxResult;
  /**
   * webNRG lab figures (Green Metrics Tool cluster), when requested. Another
   * boundary again — Firefox on Green Coding's dedicated machine — shown
   * beside the scan's own figures and never combined with them.
   */
  webnrg?: import('../webnrg/run.js').WebnrgSummary;
  /** Crawls only: how the pages were chosen. */
  sampling?: CrawlSampling;
  /**
   * Pages grouped by shared structure, when two or more pages were scanned.
   * Derived from the scenarios above, so it can be rebuilt from any result.
   */
  families?: import('../analysis/families.js').FamilyReport;
  /**
   * Components the pages are built from, which recur, and the Lighthouse
   * evidence tied to them. Structure and Chromium lab evidence, never energy.
   */
  components?: import('../analysis/components.js').ComponentInventory;
  /**
   * The component graph: pages, component types and instances, resources and
   * findings by stable id. The canonical model; the sections above and below
   * are views of the same data, kept for older readers.
   */
  graph?: import('../model/graph.js').ComponentGraph;
  /** What to look at first, in a stated order; never a score or an energy figure. */
  investigation?: import('../analysis/investigation.js').InvestigationQueue;
  /** Changes since the previous scan of the same site, when one was found. Indicative. */
  history?: import('../analysis/history.js').HistoryReport;
  /**
   * Chromium performance traces of a few pages, when requested: diagnosis in
   * another browser, never Firefox energy. The raw traces are not stored.
   */
  traces?: import('../trace/run.js').TraceRecord[];
  /**
   * measure: URLs in the list that are not HTML pages (PDFs, spreadsheets),
   * found before Firefox visited them, and skipped. A crawl records its own
   * in sampling.notHtml.
   */
  notHtml?: { url: string; contentType?: string }[];
  /** An energy experiment: baseline against one change, as a measured difference only. */
  experiment?: import('../experiments/experiment.js').ExperimentReport;
  warnings: string[];
}
