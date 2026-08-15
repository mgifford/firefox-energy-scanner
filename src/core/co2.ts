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

/** Look up green-hosting status for a domain. Network call; failures are non-fatal. */
export async function checkGreenHosting(domain: string): Promise<boolean | undefined> {
  try {
    const result = await hosting.check(domain);
    if (typeof result === 'boolean') return result;
    if (Array.isArray(result)) return result.includes(domain);
    return undefined;
  } catch {
    return undefined;
  }
}
