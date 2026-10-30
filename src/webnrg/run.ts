import { localHostReason } from '../core/addresses.js';
import {
  NotReadyError,
  REUSE_DAYS,
  VISIT_PHASE,
  detailsUrl,
  findRecentRun,
  readMetrics,
  runForJob,
  statsUrl,
  submitPage,
  webnrgPage,
  type ClientDeps,
  type WebnrgMetrics,
} from './client.js';

/**
 * Lab figures from webNRG for some of a scan's pages.
 *
 * Gentle on a free, shared service: a page measured in the last 30 days is
 * reused rather than measured again (as webNRG's own page does), new requests
 * are capped by the caller, and nothing is sent unless asked for.
 */

export type WebnrgStatus =
  /** A webNRG run from the last 30 days was reused. */
  | 'reused'
  /** Requested by this scan and finished. */
  | 'measured'
  /** Requested; still queued or running when we stopped waiting. */
  | 'submitted'
  /** No recent run, and lookup-only mode sent nothing. */
  | 'not-requested'
  | 'failed';

export interface WebnrgPage {
  /** The URL as scanned. */
  url: string;
  /** The URL as webNRG stores it. */
  page: string;
  status: WebnrgStatus;
  jobId?: number;
  runId?: string;
  measuredAt?: string;
  metrics?: WebnrgMetrics;
  error?: string;
  detailsUrl: string;
  statsUrl?: string;
}

export interface WebnrgSummary {
  tool: 'webnrg';
  /** What the figures cover, so a reader of the JSON cannot mistake them. */
  boundary: string;
  phase: string;
  reuseDays: number;
  machine?: string;
  pages: WebnrgPage[];
}

export const BOUNDARY =
  'Green Metrics Tool lab run: Playwright Firefox in a container on a dedicated machine, warm Squid cache, ' +
  'RAPL CPU package energy for the page load plus 5 s idle, no idle subtraction. Not comparable as a ratio ' +
  'with this scanner\'s own figures; shown beside them.';

export interface WebnrgOptions extends ClientDeps {
  /** Request new measurements for pages without a recent one. */
  submit: boolean;
  /** Minutes to wait for requested measurements; 0 returns at once. */
  waitMinutes: number;
  pollSeconds?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** One line, with the network reason Node's fetch keeps in `cause`. */
const firstLine = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code ?? err?.cause?.message;
  const msg = String(err?.message ?? e).split('\n')[0]!;
  return (cause && !msg.includes(cause) ? `${msg} (${cause})` : msg).slice(0, 300);
};

/** Look up, request and (optionally) wait for webNRG figures for these URLs. */
export async function runWebnrg(urls: string[], options: WebnrgOptions): Promise<WebnrgSummary> {
  const now = options.now ?? (() => new Date());
  const pages: WebnrgPage[] = [];
  let machine: string | undefined;

  for (const url of urls) {
    let page: string;
    try {
      page = webnrgPage(url);
    } catch {
      pages.push({ url, page: url, status: 'failed', error: 'not a valid URL', detailsUrl: detailsUrl(url) });
      continue;
    }
    const entry: WebnrgPage = { url, page, status: 'not-requested', detailsUrl: detailsUrl(page) };
    pages.push(entry);
    // Even a lookup carries the URL to green-coding.io, and the cluster could
    // not reach a local site anyway: refuse before anything is sent.
    const local = localHostReason(new URL(page).hostname);
    if (local) {
      Object.assign(entry, { status: 'failed', error: `${local}; webNRG only measures public sites, so nothing was sent` });
      continue;
    }
    try {
      options.onProgress?.(`webNRG: looking up ${page}`);
      const recent = await findRecentRun(page, { ...options, now: now() });
      if (recent) {
        machine ??= recent.machine;
        Object.assign(entry, {
          status: 'reused',
          runId: recent.runId,
          measuredAt: recent.createdAt,
          statsUrl: statsUrl(recent.runId),
          metrics: await readMetrics(recent.runId, options),
        });
        continue;
      }
      if (!options.submit) continue;
      options.onProgress?.(`webNRG: requesting ${page}`);
      entry.jobId = await submitPage(page, options);
      entry.status = 'submitted';
    } catch (err) {
      entry.status = 'failed';
      entry.error = firstLine(err);
    }
  }

  const summary: WebnrgSummary = {
    tool: 'webnrg',
    boundary: BOUNDARY,
    phase: VISIT_PHASE,
    reuseDays: REUSE_DAYS,
    ...(machine ? { machine } : {}),
    pages,
  };
  if (options.waitMinutes > 0) await collectWebnrg(summary, options);
  return summary;
}

/**
 * Wait for this summary's requested pages, filling in their figures. Pages
 * still running when the time is up stay 'submitted', with their job id, so
 * they can be collected later.
 */
export async function collectWebnrg(summary: WebnrgSummary, options: Omit<WebnrgOptions, 'submit'>): Promise<WebnrgSummary> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const deadline = now().getTime() + options.waitMinutes * 60_000;
  const poll = (options.pollSeconds ?? 60) * 1000;

  for (;;) {
    const waiting = summary.pages.filter((p) => p.status === 'submitted' && p.jobId !== undefined);
    if (waiting.length === 0) break;
    for (const p of waiting) {
      try {
        const run = p.runId ? { runId: p.runId, failed: false, finished: true, createdAt: p.measuredAt ?? '' } : await runForJob(p.jobId!, options);
        if (!run) continue;
        p.runId = run.runId;
        p.statsUrl = statsUrl(run.runId);
        if (run.createdAt) p.measuredAt = run.createdAt;
        if ('machine' in run && typeof run.machine === 'string') summary.machine ??= run.machine;
        if (run.failed) {
          p.status = 'failed';
          p.error = 'the measurement failed on the cluster';
          continue;
        }
        p.metrics = await readMetrics(run.runId, options);
        p.status = 'measured';
      } catch (err) {
        // "Not yet" keeps waiting; anything else is that page's answer.
        if (!(err instanceof NotReadyError)) {
          p.status = 'failed';
          p.error = firstLine(err);
        }
      }
    }
    const left = summary.pages.filter((p) => p.status === 'submitted').length;
    if (left === 0 || now().getTime() + poll > deadline) break;
    options.onProgress?.(`webNRG: waiting for ${left} measurement${left === 1 ? '' : 's'}`);
    await sleep(poll);
  }
  return summary;
}
