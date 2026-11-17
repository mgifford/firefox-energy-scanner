/**
 * A Vital Core performance investigation as an opt-in source for a Firefox
 * experiment spec.
 *
 * Vital Core publishes observations and hypotheses, not experiment
 * instructions: a candidate may name a shared resource, a slow page, a
 * regression or a Lighthouse recommendation. Only a candidate with a specific
 * resource URL/host or component selector, and a representative page, can
 * become a Firefox experiment. Everything else is rejected with a reason.
 *
 * The candidate is a hypothesis. The generated spec is a proposed upper-bound
 * intervention, never a measured saving; it is never run by this module.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExperimentSpec } from './experiment.js';
import { parseSpec } from './experiment.js';
import { safeSelector } from './variants.js';

export class VitalHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VitalHandoffError';
  }
}

export interface VitalSource {
  /** A saved path or the explicit HTTPS URL the user gave. */
  label: string;
  /** SHA-256 of the document bytes, for provenance. */
  sha256: string;
}

export interface VitalResource {
  key?: string;
  type?: string;
  third_party?: boolean;
  origin?: string;
  pages?: number;
  examples?: string[];
  transfer_bytes?: number;
  render_blocking_pages?: number;
}

export interface VitalCandidate {
  id: string;
  category: string;
  status?: string;
  evidence_strength?: string;
  resource?: VitalResource;
  page?: { url?: string; examples?: string[] };
  subject?: { selector?: string; representative_url?: string };
  selector?: string;
  component?: { selector?: string };
  intervention?: { kind?: string };
  experiment?: { kind?: string };
  hypothesis?: string;
  alternatives?: string[];
  proposed_test?: string;
  evidence?: { source?: string; denominator?: number; examples?: string[]; limitations?: string[] };
  recommendation?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VitalDocument {
  source: VitalSource;
  /** The performance-investigation/1 object. */
  investigations: { schema_version: string; candidates: VitalCandidate[]; [key: string]: unknown };
  candidates: VitalCandidate[];
  /** performance.resources.resources, when the input is a full snapshot. */
  resources: VitalResource[];
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const isHttp = (v: string | undefined): v is string => !!v && /^https?:\/\//i.test(v);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Read a saved JSON file or an explicitly supplied HTTPS snapshot. No crawling. */
export async function loadVitalDocument(input: string): Promise<VitalDocument> {
  let text: string;
  let label = input;
  if (/^https:\/\//i.test(input)) {
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      res = await fetch(input, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (e) {
      throw new VitalHandoffError(`Could not fetch ${input}: ${(e as Error).message}. Save the snapshot locally and pass its path instead.`);
    }
    if (!res.ok) throw new VitalHandoffError(`Could not fetch ${input}: HTTP ${res.status}. Save the snapshot locally and pass its path instead.`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > 20 * 1024 * 1024) throw new VitalHandoffError(`${input} is larger than 20 MB; refusing it.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new VitalHandoffError(`${input} is larger than 20 MB; refusing it.`);
    text = new TextDecoder().decode(bytes);
    label = input;
  } else if (/^http:\/\//i.test(input)) {
    throw new VitalHandoffError('Only https:// URLs are accepted for a remote Vital Core snapshot; use a saved file for anything else.');
  } else {
    const path = resolve(input);
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new VitalHandoffError(code === 'ENOENT' ? `No Vital Core snapshot at ${input}.` : `Could not read ${input}: ${(e as Error).message}`);
    }
    label = input;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new VitalHandoffError(`${label} is not JSON: ${(e as Error).message}`);
  }
  return parseVitalDocument(raw, { label, sha256: hash(text) });
}

/** Validate the snapshot or a standalone performance-investigation/1 document. */
export function parseVitalDocument(raw: unknown, source: VitalSource): VitalDocument {
  const root = asRecord(raw);
  if (!root) throw new VitalHandoffError('The Vital Core input is not a JSON object.');

  const performance = asRecord(root.performance);
  const snapshotInvestigations = asRecord(performance?.investigations);
  const standalone = root.schema_version === 'performance-investigation/1' && Array.isArray(root.candidates);
  const investigations = snapshotInvestigations ?? (standalone ? root : undefined);
  if (!investigations) {
    if (Array.isArray(root.candidates)) {
      throw new VitalHandoffError(
        'This looks like a performance-investigation document but has no schema_version; expected performance-investigation/1.',
      );
    }
    throw new VitalHandoffError(
      'This is neither a Vital Core snapshot (no performance.investigations) nor a performance-investigation/1 document. Pass the saved snapshot.json or the investigation document itself.',
    );
  }

  const version = asString(investigations.schema_version);
  if (version !== 'performance-investigation/1') {
    throw new VitalHandoffError(
      `Unsupported Vital Core performance investigation schema: ${version ?? 'missing'}. Firefox supports performance-investigation/1.`,
    );
  }
  const rawCandidates = investigations.candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    throw new VitalHandoffError('The performance-investigation/1 document has no candidates.');
  }
  const candidates: VitalCandidate[] = rawCandidates.map((c, i) => {
    const candidate = asRecord(c);
    const id = asString(candidate?.id);
    const category = asString(candidate?.category);
    if (!candidate || !id || !category) {
      throw new VitalHandoffError(`Candidate ${i + 1} is missing a string id or category.`);
    }
    return { ...(candidate as Omit<VitalCandidate, 'id' | 'category'>), id, category };
  });

  const resourceDoc = asRecord(performance?.resources);
  const rawResources = resourceDoc?.resources;
  const resources: VitalResource[] = Array.isArray(rawResources)
    ? rawResources.flatMap((r) => {
        const resource = asRecord(r);
        const key = asString(resource?.key);
        if (!resource || !key) return [];
        return [{ ...(resource as VitalResource), key }];
      })
    : [];

  return { source, investigations: investigations as VitalDocument['investigations'], candidates, resources };
}

export function selectVitalCandidate(doc: VitalDocument, id: string): VitalCandidate {
  const candidate = doc.candidates.find((c) => c.id === id);
  if (candidate) return candidate;
  const available = doc.candidates.slice(0, 8).map((c) => c.id).join('; ');
  throw new VitalHandoffError(`No Vital Core candidate "${id}". Available: ${available || 'none'}.`);
}

const inventoryFor = (doc: VitalDocument, candidate: VitalCandidate): VitalResource | undefined => {
  const key = candidate.resource?.key;
  return key ? doc.resources.find((r) => r.key === key) : undefined;
};

const pageOf = (candidate: VitalCandidate, resource: VitalResource | undefined): { url: string; from: string } | undefined => {
  if (isHttp(candidate.page?.url)) return { url: candidate.page.url, from: 'the candidate’s page.url' };
  if (isHttp(candidate.subject?.representative_url)) return { url: candidate.subject.representative_url, from: 'the candidate’s subject.representative_url' };
  const evidence = candidate.evidence?.examples?.find(isHttp);
  if (evidence) return { url: evidence, from: 'the candidate’s evidence example' };
  const inventory = resource?.examples?.find(isHttp);
  if (inventory) return { url: inventory, from: 'the first page example for this resource in performance.resources' };
  return undefined;
};

const selectorOf = (candidate: VitalCandidate): string | undefined => {
  const raw = candidate.subject?.selector ?? candidate.selector ?? candidate.component?.selector;
  const selector = safeSelector(raw);
  if (raw && !selector) throw new VitalHandoffError(`Candidate "${candidate.id}" has an unsafe selector; refusing to place it in a page.`);
  return selector;
};

const categoryReason: Record<string, string> = {
  'slow-representative-page': 'it names a low-scoring page but no specific resource, host or component to change',
  'page-family-performance-pattern': 'it names a page family, not one representative page with a testable intervention',
  'possible-matched-page-regression': 'it reports a Lighthouse score change, not a specific intervention',
  'repeated-lighthouse-recommendation': 'it aggregates a Lighthouse recommendation without a page URL, resource URL or selector',
};

const componentKind = (candidate: VitalCandidate): 'hide' | 'remove' | 'remove-before-load' | 'pause-animations' => {
  const asked = candidate.intervention?.kind ?? candidate.experiment?.kind;
  const allowed = ['hide', 'remove', 'remove-before-load', 'pause-animations'] as const;
  if (asked) {
    if (!(allowed as readonly string[]).includes(asked)) {
      throw new VitalHandoffError(`Candidate "${candidate.id}" asks for "${asked}", which is not a component experiment Firefox supports (${allowed.join(', ')}).`);
    }
    return asked as (typeof allowed)[number];
  }
  // A selector with no stated intervention gets the least destructive test.
  return candidate.category.includes('animation') ? 'pause-animations' : 'hide';
};

/** Build a valid spec, or reject the candidate with a compatibility reason. */
export function specFromVitalCandidate(doc: VitalDocument, id: string): { spec: ExperimentSpec; reason: string } {
  const candidate = selectVitalCandidate(doc, id);
  const resource = inventoryFor(doc, candidate);
  const selector = selectorOf(candidate);

  // A page-family, score regression or recommendation is not an intervention,
  // even if it names a page. Say that before looking for a testable page.
  if (!selector && categoryReason[candidate.category]) {
    throw new VitalHandoffError(
      `Candidate "${candidate.id}" (${candidate.category}) has no compatible Firefox experiment: ${categoryReason[candidate.category]}. ` +
        'Vital Core needs to publish a machine-readable experiment field (kind plus selector, host or URL, and a representative page) before this can be tested.',
    );
  }

  const page = pageOf(candidate, resource);

  if (!page) {
    throw new VitalHandoffError(
      `Candidate "${candidate.id}" has no representative page URL. ` +
        (resource
          ? 'Vital Core’s resource inventory has no page example for this key.'
          : 'No page.url, subject.representative_url, evidence example or resource example was published.') +
        ' No experiment can be run without a page; Vital Core needs to publish one.',
    );
  }

  const key = asString(candidate.resource?.key) ?? asString(resource?.key);
  const origin = asString(candidate.resource?.origin) ?? asString(resource?.origin);
  const type = asString(candidate.resource?.type) ?? asString(resource?.type);
  const base = {
    url: page.url,
    idle_ms: 10_000,
    settle_ms: 2_000,
    assertions: [{ role: 'main' }],
    runs: 10,
    warmups: 2,
    seed: `vital-${hash(candidate.id).slice(0, 12)}`,
  };

  const provenance = (what: string, intervention: string) => {
    const evidence = candidate.evidence;
    const lines = [
      `Vital Core candidate ${candidate.id} (${candidate.category}).`,
      `Source: ${doc.source.label} (sha256 ${doc.source.sha256}).`,
      ...(evidence?.source ? [`Vital Core evidence: ${evidence.source}${evidence.denominator !== undefined ? `, denominator ${evidence.denominator}` : ''}.`] : []),
      ...(candidate.resource?.pages !== undefined ? [`Vital Core observed reach: ${candidate.resource.pages} sampled page(s).`] : []),
      ...(candidate.resource?.transfer_bytes !== undefined
        ? [`Vital Core transfer observation: ${candidate.resource.transfer_bytes} bytes (a transfer estimate, not measured energy).`]
        : []),
      `Representative page: ${page.url} (${page.from}).`,
      `Proposed intervention: ${intervention}`,
      `What this tests: ${what}`,
      'This is a controlled upper bound, not a measured saving or a production recommendation. Check the functional assertion and the page’s real behaviour before running; a successful block does not prove the same change helps every page or user.',
      ...(candidate.hypothesis ? [`Vital Core hypothesis: ${candidate.hypothesis}`] : []),
      ...(evidence?.limitations?.length ? [`Vital Core limitations: ${evidence.limitations.join(' ')}`] : []),
    ];
    return lines.join('\n');
  };

  if (selector) {
    const kind = componentKind(candidate);
    const spec = parseSpec({
      ...base,
      name: `vital-${safeName(candidate.id)}`,
      kind,
      selector,
      note: provenance(
        `A ${kind} experiment on the selector Vital Core published. It changes only that component; scripts it did not load can keep running.`,
        `${kind} on ${selector}`,
      ),
    });
    return { spec, reason: `Vital Core candidate ${candidate.id}: ${kind} ${selector} on ${page.url}.` };
  }

  if (candidate.category === 'third-party-resource-concern') {
    const host = origin && !/[:/]/.test(origin) ? origin : (key ? hostOf(key) : undefined);
    if (!host) throw new VitalHandoffError(`Candidate "${candidate.id}" names a third-party resource but no usable host (origin or absolute resource URL).`);
    const spec = parseSpec({
      ...base,
      name: `vital-${safeName(candidate.id)}`,
      kind: 'block',
      hosts: [host],
      note: provenance(
        `Refusing requests to ${host} tests what the page’s third-party resources from that host cost, as an upper bound for a facade, deferral or removal. It can affect more than the named resource.`,
        `block host ${host}`,
      ),
    });
    return { spec, reason: `Vital Core candidate ${candidate.id}: block host ${host} on ${page.url}.` };
  }

  if (candidate.category === 'potential-render-blocking-resource' || candidate.category === 'shared-expensive-resource') {
    if (!isHttp(key)) {
      throw new VitalHandoffError(`Candidate "${candidate.id}" names a resource but no absolute http(s) resource URL in resource.key. Firefox will not invent one.`);
    }
    if (candidate.category === 'potential-render-blocking-resource' && type && !['script', 'link', 'stylesheet', 'style'].includes(type)) {
      throw new VitalHandoffError(`Candidate "${candidate.id}" is a ${type} resource; a render-blocking experiment maps only script and stylesheet resources.`);
    }
    const spec = parseSpec({
      ...base,
      name: `vital-${safeName(candidate.id)}`,
      kind: 'block',
      urls: [key],
      note: provenance(
        `Refusing ${key} tests what this resource costs as an upper bound for deferring, splitting, or removing it. The page may depend on it; the block probe shows whether the request was actually refused.`,
        `block URL ${key}`,
      ),
    });
    return { spec, reason: `Vital Core candidate ${candidate.id}: block ${key} on ${page.url}.` };
  }

  throw new VitalHandoffError(
    `Unsupported Vital Core category "${candidate.category}" for candidate "${candidate.id}". ` +
      'Firefox can test a specific component selector, resource URL or third-party host; it will not infer one from a score, family or recommendation.',
  );
}

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};

const safeName = (id: string): string => {
  const slug = id
    .toLowerCase()
    .replace(/^[a-z-]+:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 68);
  return slug || hash(id).slice(0, 12);
};
