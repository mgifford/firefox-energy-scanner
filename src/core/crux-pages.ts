import { cruxTarget, fetchCrux, type CruxFormFactorFilter, type CruxResult } from './crux.js';

/**
 * CrUX for many URLs: which pages real Chrome users visit, and their field
 * data. A URL has a CrUX record only when it had enough real Chrome page views
 * over 28 days (and is public), so "has a record" is a popularity signal from
 * real use, not a guess from its address. "No record" means too little Chrome
 * traffic, or a page CrUX does not cover; it does not mean nobody visits it.
 *
 * Queries are capped, and paced to stay inside the API's quota of 150 a
 * minute. A private, local or development URL is never sent: cruxTarget
 * refuses it, and it is recorded as not checked.
 */

export interface CruxPagesOptions {
  apiKey: string;
  formFactor?: CruxFormFactorFilter;
  /** At most this many queries in all. */
  max: number;
  /** Least time between queries, ms. 420 keeps under 150 a minute. */
  intervalMs?: number;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The API's quota is 150 queries a minute; this stays under it. */
export const CRUX_INTERVAL_MS = 420;
/** Queries per scan unless --crux-max says otherwise. */
export const CRUX_DEFAULT_MAX = 100;

/**
 * A cache of URL-level CrUX results with a shared budget, so the sample's
 * popularity checks and the measured pages' field data spend one quota.
 */
export class CruxPages {
  private readonly results = new Map<string, CruxResult>();
  private queries = 0;
  private last = 0;
  private stopped: string | undefined;

  constructor(private readonly options: CruxPagesOptions) {}

  /** Why querying stopped early (quota, key), if it did. */
  get stoppedBecause(): string | undefined {
    return this.stopped;
  }

  get queried(): number {
    return this.queries;
  }

  /** Results already fetched. */
  get(url: string): CruxResult | undefined {
    return this.results.get(url);
  }

  /** Query each URL not already known, in order, until the budget runs out. */
  async check(urls: string[]): Promise<Map<string, CruxResult>> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const interval = this.options.intervalMs ?? CRUX_INTERVAL_MS;
    for (const url of urls) {
      if (this.results.has(url)) continue;
      if (this.stopped || this.queries >= this.options.max) break;
      try {
        cruxTarget(url);
      } catch {
        continue; // never sent: private, local or not http(s)
      }
      const wait = this.last + interval - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.queries++;
      const r = await fetchCrux({
        target: url,
        scope: 'url',
        apiKey: this.options.apiKey,
        ...(this.options.formFactor ? { formFactor: this.options.formFactor } : {}),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      });
      // A quota or key problem will not fix itself in this scan: stop asking.
      if (r.status === 'error' && /HTTP (429|400|401|403)\b/.test(r.detail ?? '')) {
        this.stopped = r.detail;
        break;
      }
      this.results.set(url, r);
    }
    return new Map(urls.filter((u) => this.results.has(u)).map((u) => [u, this.results.get(u)!]));
  }

  /** The URLs among these that have a record: pages real Chrome users visit. */
  async withRecord(urls: string[]): Promise<Set<string>> {
    const found = await this.check(urls);
    return new Set([...found].filter(([, r]) => r.status === 'ok').map(([u]) => u));
  }
}
