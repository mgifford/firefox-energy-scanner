import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { co2 as Co2, hosting } from '@tgwf/co2';
import type { Co2Result } from '../core/types.js';

const require = createRequire(import.meta.url);

/** Models verified present in @tgwf/co2 v0.19.0. */
export const SUPPORTED_MODELS = ['swd', '1byte'] as const;
export type Co2Model = (typeof SUPPORTED_MODELS)[number];

export function isSupportedModel(m: string): m is Co2Model {
  return (SUPPORTED_MODELS as readonly string[]).includes(m);
}

let cachedVersion: string | undefined;

/** Read the installed @tgwf/co2 version; recorded in every result. */
export function co2jsVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    // The package blocks './package.json' via "exports", so resolve the entry
    // point and walk up to the manifest instead.
    const entry = require.resolve('@tgwf/co2');
    const marker = `${'node_modules'}/@tgwf/co2/`;
    const idx = entry.indexOf(marker);
    if (idx !== -1) {
      const manifest = `${entry.slice(0, idx + marker.length)}package.json`;
      cachedVersion = JSON.parse(readFileSync(manifest, 'utf8')).version as string;
    }
  } catch {
    /* fall through */
  }
  return (cachedVersion ??= 'unknown');
}

export interface Co2Options {
  model: Co2Model;
  /** Green hosting status, when known. */
  greenHosting?: boolean;
}

/**
 * Estimate modelled emissions for a byte count.
 *
 * This is a MODELLED estimate with a network/datacentre/device boundary. It is
 * not a measurement, and it must never be summed with or substituted for the
 * observed client energy. Segmented output is requested so that the
 * device-side portion — the segment that overlaps our energy measurement —
 * stays separately visible. See docs/methodology.md.
 */
export function estimateCo2(bytes: number, options: Co2Options): Co2Result {
  const green = options.greenHosting ?? false;
  const segmented = new Co2({ model: options.model, results: 'segment' });
  const total = new Co2({ model: options.model });

  const grams = total.perByte(bytes, green) as number;

  const result: Co2Result = {
    library: '@tgwf/co2',
    libraryVersion: co2jsVersion(),
    model: options.model,
    greenHosting: green,
    greenHostingChecked: options.greenHosting !== undefined,
    inputBytes: bytes,
    estimatedGrams: grams,
  };

  // Segmented results are only produced by the sustainable-web-design model.
  try {
    const seg = segmented.perByte(bytes, green);
    if (seg && typeof seg === 'object') {
      result.consumerDeviceGrams = seg.consumerDeviceCO2e;
      result.networkGrams = seg.networkCO2e;
      result.dataCenterGrams = seg.dataCenterCO2e;
    }
  } catch {
    /* segmentation unavailable for this model */
  }

  return result;
}

/**
 * Estimate per domain: bytes from green-hosted domains with the model's green
 * factor, the rest without. The models are linear in bytes, so this is exact,
 * and it is fairer than one flag for the whole page: third-party scripts,
 * fonts and images are often hosted somewhere else entirely. A domain absent
 * from `green` (unknown, or the lookup failed) counts as not green, which is
 * also the model's default.
 */
export function estimateCo2ByDomain(
  bytesByDomain: Map<string, number>,
  green: Map<string, boolean>,
  model: Co2Model,
): Co2Result {
  let greenBytes = 0;
  let otherBytes = 0;
  for (const [domain, bytes] of bytesByDomain) {
    if (green.get(domain) === true) greenBytes += bytes;
    else otherBytes += bytes;
  }
  const parts = [
    ...(greenBytes > 0 ? [estimateCo2(greenBytes, { model, greenHosting: true })] : []),
    ...(otherBytes > 0 || greenBytes === 0 ? [estimateCo2(otherBytes, { model, greenHosting: false })] : []),
  ];
  const sum = (key: 'estimatedGrams' | 'consumerDeviceGrams' | 'networkGrams' | 'dataCenterGrams') =>
    parts.every((p) => typeof p[key] === 'number') ? parts.reduce((t, p) => t + (p[key] as number), 0) : undefined;
  const result: Co2Result = {
    ...parts[0]!,
    greenHosting: otherBytes === 0 && greenBytes > 0,
    greenHostingChecked: true,
    greenBytes,
    inputBytes: greenBytes + otherBytes,
    estimatedGrams: sum('estimatedGrams')!,
  };
  for (const key of ['consumerDeviceGrams', 'networkGrams', 'dataCenterGrams'] as const) {
    const v = sum(key);
    if (v === undefined) delete result[key];
    else result[key] = v;
  }
  return result;
}

/**
 * Green-hosting status for many domains, from the Green Web Foundation's
 * Greencheck API, a batch at a time. A domain missing from the map is
 * unknown: the lookup failed or the API did not answer for it.
 */
export async function lookupGreenHosting(domains: string[], batchSize = 20): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const unique = [...new Set(domains.map((d) => d.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    try {
      const res = await hosting(batch, { verbose: true, userAgentIdentifier: 'firefox-energy-scanner' });
      if (!res || typeof res !== 'object' || Array.isArray(res)) continue;
      for (const [key, v] of Object.entries(res)) {
        const domain = String(v?.url ?? key).toLowerCase();
        if (typeof v?.green === 'boolean' && batch.includes(domain)) out.set(domain, v.green);
      }
    } catch {
      /* unknown; counted as not green */
    }
  }
  return out;
}

/** Look up green-hosting status for a domain. Network call; failures are non-fatal. */
export async function checkGreenHosting(domain: string): Promise<boolean | undefined> {
  try {
    const result = await hosting(domain, 'firefox-energy-scanner');
    if (typeof result === 'boolean') return result;
    if (Array.isArray(result)) return result.includes(domain);
    return undefined;
  } catch {
    return undefined;
  }
}
