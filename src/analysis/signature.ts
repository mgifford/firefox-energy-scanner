/**
 * What a measured page is made of, as sets of features, for grouping pages
 * into families. Pure: everything comes from a stored result, so families can
 * be rebuilt from any result file, old ones included.
 *
 * Features fall into groups that are compared separately and then weighted:
 *
 * - components: component signatures from the page's structure (or, in
 *   results made before structure was recorded, its heaviest subtrees)
 * - resources: first-party scripts and stylesheets by path, third parties by host
 * - landmarks: landmark roles, counted
 * - template: the Drupal page template, when the page names one
 * - url: the URL pattern
 */

import type { StepResult } from '../core/types.js';
import { urlPattern } from './url-pattern.js';

export interface PageFeatures {
  url: string;
  pattern: string;
  components: string[];
  resources: string[];
  landmarks: string[];
  template?: string;
  /** False when the result predates structure collection; components then come from heaviest subtrees. */
  structured: boolean;
}

/** A resource by host and path, query dropped: query strings carry page URLs and cache-busters. */
export function resourceKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Numbers in a selector name one node, not a kind of node. */
const idDigits = (s: string) => s.replace(/\d+/g, ':id');

/**
 * The features of one measured page. Undefined for a step with no URL or no
 * page structure at all (a failed navigation).
 */
export function pageFeatures(step: StepResult): PageFeatures | undefined {
  if (!step.url || !step.anatomy) return undefined;
  const structure = step.anatomy.structure;

  const components = structure
    ? structure.components.filter((c) => c.method !== 'landmark').map((c) => c.signature)
    : // Older results: the five heaviest subtrees are the only structural record.
      (step.anatomy.heaviestSubtrees ?? []).map((s) => `subtree:${idDigits(s.selector)}`);

  const resources = new Set<string>();
  for (const r of step.network?.resources ?? []) {
    if (r.resourceType !== 'script' && r.resourceType !== 'stylesheet') continue;
    // Third parties often lazy-load chunks that vary by visit; the host is the stable part.
    resources.add(r.thirdParty ? `3p:${r.domain.toLowerCase()}` : `${r.resourceType}:${resourceKey(r.url)}`);
  }

  const landmarkCounts = new Map<string, number>();
  for (const l of structure?.landmarks ?? []) landmarkCounts.set(l, (landmarkCounts.get(l) ?? 0) + 1);
  const landmarks = [...landmarkCounts].map(([l, n]) => (n > 1 ? `${l}×${Math.min(n, 5)}` : l));

  const template = structure?.drupal?.pageTemplate;
  return {
    url: step.url,
    pattern: urlPattern(step.url),
    components: [...new Set(components)].sort(),
    resources: [...resources].sort(),
    landmarks: landmarks.sort(),
    ...(template ? { template } : {}),
    structured: !!structure,
  };
}

/** FNV-1a, 32-bit, as hex: small, stable, and the same in every runtime. */
export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The structural features that identify a page across scans: components,
 * landmarks, template and URL pattern. Resources are left out, because
 * aggregated asset names change on every deploy.
 */
export function structuralFeatures(f: PageFeatures): string[] {
  return [
    ...f.components.map((c) => `c:${c}`),
    ...f.landmarks.map((l) => `l:${l}`),
    ...(f.template ? [`t:${f.template}`] : []),
    `u:${f.pattern}`,
  ].sort();
}

/** A page's fingerprint: the same structure gives the same id in any scan. */
export function pageFingerprint(f: PageFeatures): string {
  return `fp-${stableHash(structuralFeatures(f).join('\n'))}`;
}
