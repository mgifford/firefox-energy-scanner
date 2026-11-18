/**
 * Build a bounded, allowlisted candidate queue from a stored result's
 * investigation queue. It proposes experiments; it never starts one.
 */
import { createHash } from 'node:crypto';
import type { BenchmarkResult } from '../core/types.js';
import { pageKey } from '../collect/urls.js';
import { specFromQueue } from '../experiments/from-queue.js';
import type { ExperimentSpec } from '../experiments/experiment.js';
import type { InvestigationItem } from './investigation.js';
import { CANDIDATE_QUEUE_SCHEMA, type AllowRule, type CandidateQueue, type QueueCandidate } from '../model/candidate-queue.js';

export interface CandidateQueueOptions {
  sourceFile: string;
  sourceSha256?: string;
  allowlist?: AllowRule[];
  maxCandidates?: number;
  maxPages?: number;
  maxEnergyRuns?: number;
  requireRemedy?: boolean;
}

/** Parse `host:`, `url:`, `prefix:` rules; a bare line is a host. */
export function parseAllowlist(text: string): AllowRule[] {
  const out: AllowRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(host|url|prefix):(.+)$/.exec(line);
    if (m) out.push({ kind: m[1] as AllowRule['kind'], value: m[2]!.trim() });
    else out.push({ kind: 'host', value: line });
  }
  return out;
}

const hash = (s: string, n = 16) => createHash('sha256').update(s).digest('hex').slice(0, n);

export function allowedBy(page: string, rules: AllowRule[]): boolean {
  let host = '';
  try {
    host = new URL(page).hostname.toLowerCase();
  } catch {
    return false;
  }
  return rules.some((r) => {
    if (r.kind === 'host') return host === r.value.toLowerCase();
    if (r.kind === 'url') {
      try {
        return pageKey(page, { queryStrategy: 'keep' }) === pageKey(r.value, { queryStrategy: 'keep' });
      } catch {
        return page === r.value;
      }
    }
    return page.startsWith(r.value);
  });
}

const estimatedRuns = (spec: ExperimentSpec | undefined): number => {
  if (!spec) return 0;
  const runs = spec.runs ?? 10;
  const warmups = spec.warmups ?? 2;
  return runs * 2 + warmups * 2;
};

export function buildCandidateQueue(result: BenchmarkResult, options: CandidateQueueOptions): CandidateQueue {
  const investigation = result.investigation;
  if (!investigation) throw new Error('This result has no investigation queue. Run `investigate` (or a crawl/measure that attaches it) first.');
  const queue = investigation;
  const viewport = result.environment.viewport;
  const targetUrl = result.target?.url ?? result.scenarios.find((s) => s.url)?.url ?? queue.items[0]?.where[0]?.page ?? null;
  let defaultRules: AllowRule[] = [];
  if (targetUrl) {
    try {
      defaultRules = [{ kind: 'host', value: new URL(targetUrl).hostname.toLowerCase() }];
    } catch {
      defaultRules = [];
    }
  }
  const allowlist = options.allowlist?.length ? options.allowlist : defaultRules;
  if (!allowlist.length) throw new Error('No allowlist and no target host to derive one from. Pass --allow-file.');
  const policy = {
    allowlist,
    maxCandidates: options.maxCandidates ?? 5,
    maxPages: options.maxPages ?? 3,
    maxEnergyRuns: options.maxEnergyRuns ?? 24,
    requireRemedy: options.requireRemedy ?? true,
  };
  if (!Number.isInteger(policy.maxCandidates) || policy.maxCandidates < 1) throw new Error('maxCandidates must be a positive integer.');
  if (!Number.isInteger(policy.maxPages) || policy.maxPages < 1) throw new Error('maxPages must be a positive integer.');
  if (!Number.isInteger(policy.maxEnergyRuns) || policy.maxEnergyRuns < 0) throw new Error('maxEnergyRuns must be a non-negative integer.');

  const source = {
    file: options.sourceFile,
    ...(options.sourceSha256 ? { sha256: options.sourceSha256 } : {}),
    schemaVersion: result.schemaVersion,
    sessionId: result.session.id,
    startedAt: result.session.startedAt,
    mode: result.session.mode,
    targetUrl,
    viewport,
    energyAdapter: result.environment.energyAdapter,
    energyTier: result.capabilities?.tier ?? ('unknown' as const),
  };
  const selected: QueueCandidate[] = [];
  const rejected: QueueCandidate[] = [];
  const seen = new Set<string>();
  const pages = new Set<string>();
  let runs = 0;

  const base = (item: InvestigationItem, page: string) => {
    let origin: string | null = null;
    try {
      origin = new URL(page).origin;
    } catch {
      origin = null;
    }
    const key = `${origin ?? 'unknown'}|${pageKey(page, { queryStrategy: 'keep' })}|${viewport.width}x${viewport.height}`;
    const target = pageKey(page, { queryStrategy: 'keep' });
    return {
      id: `cq-${hash(`${result.session.id}|${item.rank}|${item.kind}|${item.id}|${target}`)}`,
      rank: item.rank,
      kind: item.kind,
      title: item.title,
      evidence: item.evidence,
      because: item.because,
      reach: item.reach,
      workload: item.workload,
      target: { kind: item.kind, id: item.id, title: item.title, ...(item.where[0]?.selector ? { selector: item.where[0].selector } : {}), page },
      pairing: {
        key,
        page,
        siteOrigin: origin,
        viewport,
        run: { sessionId: result.session.id, startedAt: result.session.startedAt },
        source: 'fes-investigation' as const,
      },
      provenance: {
        sourceFile: options.sourceFile,
        ...(options.sourceSha256 ? { sourceSha256: options.sourceSha256 } : {}),
        investigationMethod: queue.method,
        rank: item.rank,
      },
    };
  };

  const reject = (item: InvestigationItem, page: string, reason: string, spec?: ExperimentSpec, note?: string) => {
    const b = base(item, page);
    rejected.push({
      ...b,
      status: 'rejected',
      ...(spec ? { experiment: spec } : {}),
      ...(note ? { experimentNote: note } : {}),
      estimatedEnergyRuns: estimatedRuns(spec),
      reason,
    });
  };

  for (const item of queue.items) {
    const page = item.where[0]?.page;
    if (!page) {
      reject(item, 'about:blank', 'no-page: the item has no page to test on.');
      continue;
    }
    if (!allowedBy(page, allowlist)) {
      reject(item, page, 'not-allowlisted: the page is outside the policy allowlist.');
      continue;
    }
    const dedup = `${pageKey(page, { queryStrategy: 'keep' })}|${item.kind}|${item.id}`;
    if (seen.has(dedup)) {
      reject(item, page, 'duplicate: the same page/target already appears in this queue.');
      continue;
    }
    seen.add(dedup);

    let spec: ExperimentSpec | undefined;
    let note: string | undefined;
    try {
      const made = specFromQueue(result, item.rank);
      spec = made.spec;
      note = made.note;
    } catch (e) {
      if (policy.requireRemedy) {
        reject(item, page, `no-experiment: ${(e as Error).message}`);
        continue;
      }
    }
    if (selected.length >= policy.maxCandidates) {
      reject(item, page, 'over-candidate-budget: the selected-candidate limit is reached.', spec, note);
      continue;
    }
    const newPage = !pages.has(pageKey(page, { queryStrategy: 'keep' }));
    if (newPage && pages.size >= policy.maxPages) {
      reject(item, page, 'over-page-budget: the selected-page limit is reached.', spec, note);
      continue;
    }
    const cost = estimatedRuns(spec);
    if (runs + cost > policy.maxEnergyRuns) {
      reject(item, page, 'over-energy-budget: the estimated energy-run budget would be exceeded.', spec, note);
      continue;
    }

    selected.push({
      ...base(item, page),
      status: 'selected',
      ...(spec ? { experiment: spec } : {}),
      ...(note ? { experimentNote: note } : {}),
      estimatedEnergyRuns: cost,
    });
    pages.add(pageKey(page, { queryStrategy: 'keep' }));
    runs += cost;
  }

  const queueId = `cq-${hash(JSON.stringify({ source, policy, selected: selected.map((c) => c.id), rejected: rejected.map((c) => [c.id, c.reason]) }), 20)}`;
  return {
    schema: CANDIDATE_QUEUE_SCHEMA,
    queueId,
    generatedAt: new Date().toISOString(),
    source,
    policy,
    selected,
    rejected,
    summary: {
      candidates: selected.length + rejected.length,
      selected: selected.length,
      rejected: rejected.length,
      uniquePages: pages.size,
      estimatedEnergyRuns: runs,
    },
    limitations: [
      'This is a plan only: it starts no browser, no experiment and no energy measurement.',
      'Budgets are planning limits, not evidence that a candidate is safe, worthwhile or likely to save energy.',
      'The allowlist defaults to the result target host; a bare host rule is exact, and www/non-www are separate hosts.',
      'Deduplication is within this result. A new result or session gets a new queueId; it is not a cross-run idempotency key.',
      'The pairing key records site, page, viewport and run for later joins; no accessibility, carbon or energy evidence is combined here.',
      'A candidate is still a lead: a person must review the experiment and its checks before running it.',
    ],
  };
}
