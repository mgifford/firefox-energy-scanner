/**
 * webNRG: Green Coding's website measurement on the Green Metrics Tool (GMT)
 * cluster.
 *
 * GMT opens a page in Playwright Firefox inside a container on a dedicated,
 * calibrated machine, through a warm Squid cache, and reads the CPU package's
 * RAPL energy for the page load plus five seconds of idle. That is a lab
 * figure: the same browser engine as our own measurement, but other hardware,
 * another scope (CPU package, not Firefox's processes) and no idle
 * subtraction. It is shown beside our figures and never combined with them.
 *
 * The protocol is the one webNRG's own page uses
 * (github.com/green-coding-solutions/webnrg, js/code.js and js/shared.js) and
 * co2-runner follows (github.com/mrchrisadams/co2-runner, runner/gmt.ts):
 *
 *   1. GET  api.green-coding.io/v2/runs?...            a run in the last 30 days?
 *   2. POST gateway.green-coding.io/save               if not, request one
 *   3. GET  api.green-coding.io/v2/runs?job_id=        poll until it has run
 *   4. GET  api.green-coding.io/v1/phase_stats/single/ read the figures
 *
 * Every result is public on metrics.green-coding.io.
 */

export const API_BASE = 'https://api.green-coding.io';
export const GATEWAY_SAVE_URL = 'https://gateway.green-coding.io/save';
export const WEBNRG_BASE = 'https://website-tester.green-coding.io';
export const METRICS_BASE = 'https://metrics.green-coding.io';

/**
 * The gateway accepts submissions only from origins on its allowlist. Like
 * co2-runner, we present webNRG's own origin, since we submit through the
 * same path webNRG does. If Green Coding gives this project an origin or an
 * API key of its own, set WEBNRG_ORIGIN (or change this) to match.
 */
export const DEFAULT_ORIGIN = 'https://website-tester.green-coding.io';

/** Says who is calling, so Green Coding can tell these requests apart. */
export const USER_AGENT = 'firefox-energy-scanner (+https://github.com/mgifford/firefox-energy-scanner)';

/** The GMT usage scenario a plain-URL webNRG submission runs. */
export const GMT_REPO_URI = 'https://github.com/green-coding-solutions/green-metrics-tool';
export const WEBNRG_FILENAME = 'templates/website/usage_scenario_cached.yml';
export const VISIT_PHASE = 'Visit page and idle for 5 s';
export const SCROLL_PHASE = 'Scroll down and wait for 5 s';

/** webNRG reuses a measurement of the same URL for this many days. */
export const REUSE_DAYS = 30;

export type Fetch = typeof fetch;

export interface ClientDeps {
  fetch?: Fetch;
  origin?: string;
}

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface WebnrgMetrics {
  /** CPU package energy for the page load plus 5 s idle. */
  cpuEnergyMwh?: number;
  cpuPowerW?: number;
  /** Average CPU package power while scrolling to the bottom. */
  scrollPowerW?: number;
  durationS?: number;
  /** Bytes the browser's container sent and received in the visit phase. */
  transferKb?: number;
  /** GMT's network formula for the visit phase. */
  networkCarbonMg?: number;
  /** Grid intensity at the cluster when it ran. */
  carbonIntensityG?: number;
  renderingGrade?: Grade;
  transferGrade?: Grade;
}

export interface GmtRun {
  runId: string;
  createdAt: string;
  page?: string;
  machine?: string;
  finished: boolean;
  failed: boolean;
}

/** A GMT answer that means "not yet", as opposed to "wrong". */
export class NotReadyError extends Error {}

/**
 * The URL as webNRG stores it: a protocol, and no trailing slash. Lookups
 * match on this exact string, so ours must be spelled the same way.
 */
export function webnrgPage(url: string): string {
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  new URL(full); // throws if invalid
  return full.replace(/\/+$/, '');
}

export function detailsUrl(page: string): string {
  return `${WEBNRG_BASE}/details.html?page=${encodeURIComponent(page)}`;
}

export function statsUrl(runId: string): string {
  return `${METRICS_BASE}/stats.html?id=${encodeURIComponent(runId)}`;
}

async function getJson(url: string, deps: ClientDeps): Promise<{ status: number; body: unknown }> {
  const res = await (deps.fetch ?? fetch)(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
  if (res.status === 204) return { status: 204, body: undefined };
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * Column order of a /v2/runs row, from GMT's api/scenario_runner.py:
 * id, name, uri, branch, created_at, warnings, filename,
 * usage_scenario_variables, machine description, commit_hash,
 * end_measurement, failed, machine_id, relations.
 */
export function parseRunRow(row: unknown): GmtRun | undefined {
  if (!Array.isArray(row) || typeof row[0] !== 'string') return undefined;
  const vars = (row[7] ?? {}) as Record<string, unknown>;
  return {
    runId: row[0],
    createdAt: String(row[4] ?? ''),
    ...(typeof vars.__GMT_VAR_PAGE__ === 'string' ? { page: vars.__GMT_VAR_PAGE__ } : {}),
    ...(typeof row[8] === 'string' ? { machine: row[8] } : {}),
    finished: row[10] !== null && row[10] !== undefined,
    failed: row[11] === true,
  };
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The newest finished webNRG run of exactly this page in the last `days`.
 * GMT filters variables with ILIKE, so https://a.org also returns
 * https://a.org/about; only an exact match counts.
 */
export async function findRecentRun(
  page: string,
  opts: { days?: number; now?: Date } & ClientDeps = {},
): Promise<GmtRun | undefined> {
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? REUSE_DAYS) * 86_400_000);
  const q = new URLSearchParams({
    uri: GMT_REPO_URI,
    filename: WEBNRG_FILENAME,
    failed: 'false',
    usage_scenario_variables: page,
    limit: '20',
    start_date: isoDate(since),
  });
  const { status, body } = await getJson(`${API_BASE}/v2/runs?${q}`, opts);
  if (status === 204) return undefined;
  if (status !== 200) throw new Error(`GMT API answered HTTP ${status} to the run lookup`);
  const rows = ((body as { data?: unknown[] })?.data ?? []).map(parseRunRow);
  return rows.find((r): r is GmtRun => !!r && r.page === page && r.finished && !r.failed);
}

/** Ask the gateway to measure a page. Returns the GMT job id. */
export async function submitPage(page: string, deps: ClientDeps = {}): Promise<number> {
  const res = await (deps.fetch ?? fetch)(GATEWAY_SAVE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: deps.origin ?? process.env.WEBNRG_ORIGIN ?? DEFAULT_ORIGIN,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ email: '', page, mode: 'website', schedule_mode: 'one-off' }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim().slice(0, 300);
    let hint = '';
    if (/not supported site/i.test(text)) hint = ' (the gateway did not accept our origin)';
    else if (/could not access/i.test(text)) hint = ' (the gateway could not load the page)';
    throw new Error(`webNRG gateway refused the request: HTTP ${res.status}${text ? `: ${text}` : ''}${hint}`);
  }
  const jobId = ((await res.json()) as { data?: { job_id?: unknown } })?.data?.job_id;
  if (typeof jobId !== 'number') throw new Error('webNRG gateway accepted the request but returned no job id');
  return jobId;
}

/** The run a job produced, or undefined while it is queued or running. */
export async function runForJob(jobId: number, deps: ClientDeps = {}): Promise<GmtRun | undefined> {
  const { status, body } = await getJson(`${API_BASE}/v2/runs?job_id=${jobId}&limit=1`, deps);
  if (status === 204) return undefined;
  if (status !== 200) throw new NotReadyError(`GMT API answered HTTP ${status} for job ${jobId}`);
  const run = parseRunRow((body as { data?: unknown[] })?.data?.[0]);
  if (!run || (!run.finished && !run.failed)) return undefined;
  return run;
}

type PhaseData = Record<string, { data?: Record<string, { data?: Record<string, { mean?: number }> }> }>;

function mean(phase: PhaseData | undefined, metric: string, detail: string | undefined, runId: string): number | undefined {
  const details = phase?.[metric]?.data;
  if (!details) return undefined;
  const key = detail ?? Object.keys(details)[0];
  const v = key === undefined ? undefined : details[key]?.data?.[runId]?.mean;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const scale = (v: number | undefined, by: number) => (v === undefined ? undefined : v / by);

/**
 * webNRG's grades (js/shared.js getRatings). Rendering: steps of 25% above
 * the energy of an ideal page — idle power of 2.45 W over 5.5 s, 4.679 mWh —
 * up to F beyond 2.5 times that. Transfer: the Sustainable Web Design
 * rating bands, in kB.
 */
export function renderingGrade(mWh: number | undefined): Grade | undefined {
  if (mWh === undefined || !(mWh > 0)) return undefined;
  const best = 4.6788194;
  if (mWh > best * 2.5) return 'F';
  if (mWh >= best * 2.25) return 'E';
  if (mWh >= best * 2) return 'D';
  if (mWh >= best * 1.75) return 'C';
  if (mWh >= best * 1.5) return 'B';
  if (mWh >= best * 1.25) return 'A';
  return 'A+';
}

export function transferGrade(kB: number | undefined): Grade | undefined {
  if (kB === undefined || !(kB > 0)) return undefined;
  if (kB < 272.51) return 'A+';
  if (kB <= 531.15) return 'A';
  if (kB <= 975.85) return 'B';
  if (kB <= 1410.39) return 'C';
  if (kB <= 1875.01) return 'D';
  if (kB <= 2419.56) return 'E';
  return 'F';
}

/** Pull webNRG's figures out of a /v1/phase_stats/single response body. */
export function parsePhaseStats(body: unknown, runId: string): WebnrgMetrics {
  const phases = (body as { data?: { data?: Record<string, { data?: PhaseData }> } })?.data?.data;
  const visit = phases?.[VISIT_PHASE]?.data;
  if (!visit) throw new Error(`the run has no "${VISIT_PHASE}" phase`);
  const scroll = phases?.[SCROLL_PHASE]?.data;
  const cpuEnergyMwh = scale(mean(visit, 'cpu_energy_rapl_msr_component', 'Package_0', runId), 3_600_000);
  const transferKb = scale(mean(visit, 'network_total_cgroup_container', 'gmt-playwright-nodejs', runId), 1000);
  const m: WebnrgMetrics = {
    cpuEnergyMwh,
    cpuPowerW: scale(mean(visit, 'cpu_power_rapl_msr_component', 'Package_0', runId), 1000),
    scrollPowerW: scale(mean(scroll, 'cpu_power_rapl_msr_component', 'Package_0', runId), 1000),
    durationS: scale(mean(visit, 'phase_time_syscall_system', '[SYSTEM]', runId), 1e6),
    transferKb,
    networkCarbonMg: scale(mean(visit, 'network_carbon_formula_global', '[FORMULA]', runId), 1000),
    carbonIntensityG: mean(visit, 'carbon_intensity_elephant_machine', undefined, runId),
    renderingGrade: renderingGrade(cpuEnergyMwh),
    transferGrade: transferGrade(transferKb),
  };
  for (const k of Object.keys(m) as (keyof WebnrgMetrics)[]) if (m[k] === undefined) delete m[k];
  if (m.cpuEnergyMwh === undefined) throw new Error('the run has no CPU energy figure');
  return m;
}

/** A finished run's figures. Throws NotReadyError while GMT is still summarising. */
export async function readMetrics(runId: string, deps: ClientDeps = {}): Promise<WebnrgMetrics> {
  const { status, body } = await getJson(`${API_BASE}/v1/phase_stats/single/${encodeURIComponent(runId)}`, deps);
  if (status === 204 || status === 429 || status >= 500) {
    throw new NotReadyError(`GMT has no figures for run ${runId} yet (HTTP ${status})`);
  }
  if (status !== 200) throw new Error(`GMT API answered HTTP ${status} for run ${runId}`);
  return parsePhaseStats(body, runId);
}
