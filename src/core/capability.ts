/**
 * Capability tiers.
 *
 * The same commands run everywhere, but what they can *measure* depends on the
 * host. Rather than leaving that implicit — and letting a reader assume an
 * absent number means zero — every result declares its tier and what that tier
 * can and cannot produce.
 *
 * The dividing line is physical power-measurement hardware:
 *
 *   full      physical Apple Silicon (or Windows 11). Firefox's power counters
 *             emit real samples, so energy, baselines and A/B regression work.
 *   structural  any other host, including every GitHub-hosted runner. Network,
 *             CO2.js, timings and page structure are all fully valid — none of
 *             them depend on power hardware — but there is no energy.
 */

export type CapabilityTier = 'full' | 'structural';

export interface Capabilities {
  tier: CapabilityTier;
  /** Metrics this host can produce. */
  available: string[];
  /** Metrics it cannot, with the reason. */
  unavailable: { metric: string; reason: string }[];
  /** One-line summary for reports. */
  summary: string;
}

const STRUCTURAL_METRICS = [
  'transferred bytes',
  'request counts and resource types',
  'first/third-party split',
  'CO2.js modelled emissions',
  'navigation timings',
  'largest contentful paint',
  'DOM size and depth',
  'CSS rule and selector counts',
  'image and script inventory',
  'structural findings',
  'payload triage between two targets',
];

const ENERGY_METRICS = [
  'observed client energy (joules / mWh)',
  'idle baseline subtraction',
  'resolution check (is the effect above the noise floor)',
  'energy apportioned to work categories',
  'A/B energy regression comparison',
];

export interface CapabilityInput {
  /** True only when power counters produced real samples. */
  powerSamplesObserved: boolean;
  platform: string;
  architecture: string;
  /** True when the host is a virtual machine, when known. */
  virtualised?: boolean;
}

export function describeCapabilities(input: CapabilityInput): Capabilities {
  if (input.powerSamplesObserved) {
    return {
      tier: 'full',
      available: [...STRUCTURAL_METRICS, ...ENERGY_METRICS],
      unavailable: [],
      summary:
        'Full tier: power counters produced samples, so energy measurement and A/B ' +
        'regression are available alongside all structural metrics.',
    };
  }

  const reason = input.virtualised
    ? `${input.platform}/${input.architecture} is virtualised, and the host does not expose ` +
      'power-measurement hardware to the guest.'
    : `${input.platform}/${input.architecture} has no Firefox power counters. ` +
      'Verified support: physical Apple Silicon macOS, and Windows 11.';

  return {
    tier: 'structural',
    available: STRUCTURAL_METRICS,
    unavailable: ENERGY_METRICS.map((metric) => ({ metric, reason })),
    summary:
      'Structural tier: no energy measurement on this host. Network, CO2.js, timing and ' +
      'page-structure metrics are fully valid — none of them depend on power hardware.',
  };
}

/**
 * Detect whether the host is a virtual machine.
 *
 * Only meaningful on macOS, where `hw.model` reports `VirtualMac*` and
 * `kern.hv_vmm_present` is 1 under a hypervisor.
 */
export async function detectVirtualisation(): Promise<boolean | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const [model, vmm] = await Promise.all([
      run('sysctl', ['-n', 'hw.model'], { timeout: 4000 }).then((r) => r.stdout.trim()).catch(() => ''),
      run('sysctl', ['-n', 'kern.hv_vmm_present'], { timeout: 4000 })
        .then((r) => r.stdout.trim())
        .catch(() => ''),
    ]);
    if (/^Virtual/i.test(model)) return true;
    if (vmm === '1') return true;
    return false;
  } catch {
    return undefined;
  }
}
