import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * Can this host measure energy, and if not, what would make it?
 *
 * Platform is not proof. A virtual machine can expose a power counter that
 * never emits a sample, and a bare-metal Linux box can have working RAPL
 * counters that Firefox is not allowed to read. So the probe gathers host
 * facts, runs Firefox briefly with the profiler on, counts real samples, and
 * turns all of that into one verdict with concrete next steps.
 *
 * The verdict logic (judgeEnergy) is pure, so it is tested without hardware.
 */

export type EnergyVerdict = 'energy' | 'fixable' | 'unavailable' | 'untested';

export interface LinuxRapl {
  /**
   * The kernel offers at least one RAPL energy event. A `power` event source
   * with no energy-* events (seen on virtual machines) does not count.
   */
  pmu: boolean;
  /** RAPL domains the kernel offers, e.g. ["cores", "pkg", "ram"]. */
  events: string[];
  /** kernel.perf_event_paranoid; Firefox needs <= 0 for system-wide RAPL. */
  paranoid?: number;
}

export interface HostFacts {
  platform: string;
  arch: string;
  virtualised?: boolean;
  /** Hypervisor or cloud vendor, when the host says so. */
  hypervisor?: string;
  linux?: LinuxRapl;
}

export interface FirefoxProbe {
  samples: number;
  counters: string[];
  scope?: 'process' | 'cpu-package' | 'system';
  error?: string;
}

export interface EnergyProbe extends HostFacts {
  firefox?: FirefoxProbe;
  verdict: EnergyVerdict;
  reason: string;
  nextSteps: string[];
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
};

export function linuxRaplStatus(): LinuxRapl {
  const base = '/sys/bus/event_source/devices/power';
  let events: string[] = [];
  try {
    events = readdirSync(`${base}/events`)
      .filter((f) => /^energy-[a-z]+$/.test(f))
      .map((f) => f.slice('energy-'.length))
      .sort();
  } catch {
    events = [];
  }
  const paranoidRaw = read('/proc/sys/kernel/perf_event_paranoid');
  const paranoid = paranoidRaw !== undefined ? Number.parseInt(paranoidRaw, 10) : undefined;
  return {
    pmu: existsSync(`${base}/type`) && events.length > 0,
    events,
    ...(paranoid !== undefined && Number.isFinite(paranoid) ? { paranoid } : {}),
  };
}

/**
 * Linux virtual machine detection without extra tools: the CPU's
 * `hypervisor` flag, and the DMI vendor (Azure, AWS, GCP, QEMU and so on).
 */
export function linuxVirtualisation(): { virtualised?: boolean; hypervisor?: string } {
  const cpuinfo = read('/proc/cpuinfo');
  const flagged = cpuinfo ? /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo) : undefined;
  const vendor = read('/sys/class/dmi/id/sys_vendor');
  const product = read('/sys/class/dmi/id/product_name');
  const xen = read('/sys/hypervisor/type');
  const known = /microsoft|amazon|google|qemu|kvm|vmware|virtualbox|xen|innotek|parallels|openstack|digitalocean|hetzner/i;
  const dmi = [vendor, product].filter(Boolean).join(' ');
  const vmByDmi = dmi ? known.test(dmi) && !/surface/i.test(dmi) : false;
  const virtualised = flagged || vmByDmi || !!xen ? true : flagged === false ? false : undefined;
  const hypervisor = xen ? `Xen (${xen})` : vmByDmi ? dmi : flagged ? 'unidentified hypervisor' : undefined;
  return {
    ...(virtualised !== undefined ? { virtualised } : {}),
    ...(hypervisor ? { hypervisor } : {}),
  };
}

export async function collectHostFacts(): Promise<HostFacts> {
  const facts: HostFacts = { platform: process.platform, arch: process.arch };
  if (process.platform === 'linux') {
    Object.assign(facts, linuxVirtualisation());
    facts.linux = linuxRaplStatus();
  } else if (process.platform === 'darwin') {
    const { detectVirtualisation } = await import('../core/capability.js');
    const v = await detectVirtualisation();
    if (v !== undefined) facts.virtualised = v;
    if (v) facts.hypervisor = 'Apple Virtualization (macOS guest)';
  } else if (process.platform === 'win32') {
    Object.assign(facts, await windowsVirtualisation());
  }
  return facts;
}

/** Windows reports the hypervisor through the system model and manufacturer. */
async function windowsVirtualisation(): Promise<{ virtualised?: boolean; hypervisor?: string }> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        '$c = Get-CimInstance Win32_ComputerSystem; "$($c.Manufacturer)|$($c.Model)|$($c.HypervisorPresent)"'],
      { timeout: 15000, windowsHide: true },
    );
    const [maker = '', model = '', present = ''] = stdout.trim().split('|');
    const vm = /virtual|vmware|qemu|kvm|xen|parallels|virtualbox/i.test(`${maker} ${model}`);
    // HypervisorPresent is also true on a physical PC with Hyper-V or VBS on,
    // so on its own it does not mean "virtual machine".
    if (vm) return { virtualised: true, hypervisor: `${maker} ${model}`.trim() };
    return present ? { virtualised: false } : {};
  } catch {
    return {};
  }
}

/** Where energy measurement does work, best first. Shown whenever this host cannot. */
export const ENERGY_OPTIONS = [
  'A physical Apple Silicon Mac: per-process Firefox energy, no setup or admin rights. The most precise option.',
  'A Linux PC on bare metal with an Intel or AMD CPU: run `sudo sysctl kernel.perf_event_paranoid=0` once per boot. ' +
    'Measures the whole CPU package, so close other applications.',
  'A Windows 11 PC on a supported Intel, AMD or ARM CPU: CPU package energy, no setup.',
  'Run the CLI on one of these, or register it as a self-hosted runner so issue scans use it (docs/self-hosted-runner.md).',
];

const SCOPE_TEXT: Record<NonNullable<FirefoxProbe['scope']>, string> = {
  process: 'per-process Firefox energy',
  'cpu-package': 'whole-CPU-package energy (every process on the machine, not only Firefox)',
  system: 'whole-platform energy (every process on the machine, not only Firefox)',
};

/** Turn host facts and the Firefox probe into a verdict. Pure. */
export function judgeEnergy(facts: HostFacts, firefox?: FirefoxProbe): Omit<EnergyProbe, keyof HostFacts | 'firefox'> {
  if (firefox && firefox.samples > 0) {
    const scope = firefox.scope ? SCOPE_TEXT[firefox.scope] : 'energy';
    return {
      verdict: 'energy',
      reason: `Firefox recorded ${firefox.samples} power samples: this host measures ${scope}.`,
      nextSteps:
        firefox.scope && firefox.scope !== 'process'
          ? ['Close other applications while measuring; the idle baseline is subtracted, but background work still adds noise.']
          : [],
    };
  }

  const where = `${facts.platform}/${facts.arch}`;
  if (facts.virtualised) {
    return {
      verdict: 'unavailable',
      reason:
        `This host is a virtual machine (${facts.hypervisor ?? 'hypervisor detected'}). Virtual machines ` +
        'do not normally pass power-measurement hardware through to the guest, so energy cannot be measured here.' +
        (firefox && !firefox.error ? ` Firefox recorded 0 power samples.` : ''),
      nextSteps: ENERGY_OPTIONS,
    };
  }

  if (facts.platform === 'linux' && facts.linux) {
    const l = facts.linux;
    if (!l.pmu) {
      return {
        verdict: 'unavailable',
        reason: 'The kernel exposes no RAPL energy events (/sys/bus/event_source/devices/power/events/energy-*).',
        nextSteps: ['Check the CPU is Intel, or AMD Zen with Linux 5.8 or later.', ...ENERGY_OPTIONS],
      };
    }
    if (l.paranoid === undefined || l.paranoid > 0) {
      return {
        verdict: 'fixable',
        reason:
          `RAPL power events are present (${l.events.join(', ') || 'no domains listed'}), but ` +
          `kernel.perf_event_paranoid is ${l.paranoid ?? 'unreadable'}; Firefox needs 0 or lower to read them.`,
        nextSteps: [
          'Run `sudo sysctl kernel.perf_event_paranoid=0` (resets at reboot), then `web-energy doctor` again.',
          'To keep it: add `kernel.perf_event_paranoid = 0` to /etc/sysctl.d/99-perf.conf.',
        ],
      };
    }
  }

  if (firefox?.error) {
    return {
      verdict: 'untested',
      reason: `The host looks capable, but Firefox could not run the probe: ${firefox.error}`,
      nextSteps: ['Run `npx playwright install firefox`, then `web-energy doctor` again.'],
    };
  }
  if (!firefox) {
    return {
      verdict: 'untested',
      reason: `No Firefox probe was run on ${where}.`,
      nextSteps: ['Run `web-energy doctor` to probe with a real Firefox session.'],
    };
  }

  const hint =
    facts.platform === 'win32'
      ? 'Windows exposes energy only on Windows 11 with a CPU whose driver provides the Energy Meter Interface.'
      : facts.platform === 'linux'
        ? 'RAPL looks readable, so check the Firefox version (107 or later) and run with MOZ_LOG=profiler.rapl:5 to see why.'
        : facts.platform === 'darwin'
          ? 'On a physical Mac this is unexpected: check Low Power Mode is off and Firefox is up to date.'
          : '';
  return {
    verdict: 'unavailable',
    reason: `Firefox recorded 0 power samples on ${where}. ${hint}`.trim(),
    nextSteps: ENERGY_OPTIONS,
  };
}
