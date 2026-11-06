import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { HostFacts } from './probe.js';

/**
 * What kind of computer this is, for energy: an Apple Silicon Mac (the
 * common case for people running this on a Mac, and the most precise),
 * an Intel Mac, a Linux PC, Windows, or a virtual machine.
 *
 * Detection reads what the operating system reports. It predicts what a scan
 * can measure; the scan itself is the proof, and its results say what was
 * recorded.
 */
export interface Machine {
  platform: string;
  arch: string;
  /** The CPU's name as the OS reports it, such as "Apple M2 Pro" or "Intel(R) Core(TM) i7-8850H". */
  cpu?: string;
  /** An Apple Silicon (M-series) Mac, whatever this process's architecture. */
  appleSilicon?: boolean;
  /** This Node process runs under Rosetta 2, translated from Intel code. */
  rosetta?: boolean;
  /**
   * Architectures of the Firefox binary Playwright will launch (lipo -archs),
   * read only under Rosetta: whether Firefox itself runs natively is what
   * matters for its energy, not Node's architecture.
   */
  firefoxArchs?: string[];
}

/** What the OS reported, raw. Separate from detection so it is testable anywhere. */
export interface MachineReadings {
  platform: string;
  arch: string;
  /** sysctl machdep.cpu.brand_string (macOS). */
  brand?: string;
  /** sysctl hw.optional.arm64 (macOS): "1" on Apple Silicon, even under Rosetta; absent on Intel. */
  arm64?: string;
  /** sysctl sysctl.proc_translated (macOS): "1" under Rosetta. */
  translated?: string;
  /** /proc/cpuinfo (Linux). */
  cpuinfo?: string;
  /** os.cpus()[0].model, a fallback. */
  cpusModel?: string;
  /** lipo -archs on the Firefox binary (macOS, under Rosetta only). */
  firefoxLipo?: string;
}

/** Turn raw readings into a Machine. Pure. */
export function parseMachine(r: MachineReadings): Machine {
  const clean = (s?: string) => s?.replace(/\s+/g, ' ').trim() || undefined;
  if (r.platform === 'darwin') {
    const cpu = clean(r.brand) ?? clean(r.cpusModel);
    const appleSilicon = r.arm64?.trim() === '1' || r.arch === 'arm64' || /^Apple M\d/.test(cpu ?? '');
    return {
      platform: r.platform,
      arch: r.arch,
      ...(cpu ? { cpu } : {}),
      appleSilicon,
      ...(appleSilicon ? { rosetta: r.translated?.trim() === '1' || r.arch === 'x64' } : {}),
      ...(r.firefoxLipo?.trim() ? { firefoxArchs: r.firefoxLipo.trim().split(/\s+/) } : {}),
    };
  }
  const fromCpuinfo = r.cpuinfo ? /^(?:model name|Hardware|Processor)\s*:\s*(.+)$/m.exec(r.cpuinfo)?.[1] : undefined;
  const cpu = clean(fromCpuinfo) ?? clean(r.cpusModel);
  return { platform: r.platform, arch: r.arch, ...(cpu ? { cpu } : {}) };
}

const execFileAsync = promisify(execFile);
async function sysctl(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', name], { timeout: 4000 });
    return stdout.trim();
  } catch {
    return undefined; // an unknown name (hw.optional.arm64 on an Intel Mac) is an error
  }
}

/** Which architectures the Firefox that Playwright launches is built for, e.g. "arm64". */
async function firefoxArchitectures(): Promise<string | undefined> {
  try {
    const { firefox } = await import('playwright');
    const { stdout } = await execFileAsync('lipo', ['-archs', firefox.executablePath()], { timeout: 4000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined; // Firefox not installed yet, or no lipo
  }
}

/** Read this machine. Never throws. */
export async function detectMachine(): Promise<Machine> {
  const cpusModel = os.cpus()[0]?.model;
  if (process.platform === 'darwin') {
    const [brand, arm64, translated] = await Promise.all([sysctl('machdep.cpu.brand_string'), sysctl('hw.optional.arm64'), sysctl('sysctl.proc_translated')]);
    const base = { platform: 'darwin', arch: process.arch, ...(brand ? { brand } : {}), ...(arm64 ? { arm64 } : {}), ...(translated ? { translated } : {}), ...(cpusModel ? { cpusModel } : {}) };
    const m = parseMachine(base);
    if (!m.rosetta) return m;
    const firefoxLipo = await firefoxArchitectures();
    return firefoxLipo ? parseMachine({ ...base, firefoxLipo }) : m;
  }
  let cpuinfo: string | undefined;
  if (process.platform === 'linux') {
    try {
      cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
    } catch {
      /* none */
    }
  }
  return parseMachine({ platform: process.platform, arch: process.arch, ...(cpuinfo ? { cpuinfo } : {}), ...(cpusModel ? { cpusModel } : {}) });
}

/** A short name for the machine, for messages. */
export function machineName(m: Machine): string {
  if (m.platform === 'darwin') return m.appleSilicon ? `${m.cpu ?? 'Apple Silicon'} Mac` : `Intel Mac${m.cpu ? ` (${m.cpu})` : ''}`;
  if (m.platform === 'linux') return `Linux PC${m.cpu ? ` (${m.cpu})` : ''}`;
  if (m.platform === 'win32') return `Windows PC${m.cpu ? ` (${m.cpu})` : ''}`;
  return `${m.platform}/${m.arch}`;
}

export interface Preflight {
  /** ok: energy is expected; note: it may be; warn: it will not be unless something changes; off: not requested. */
  level: 'ok' | 'note' | 'warn' | 'off';
  lines: string[];
}

/**
 * Before a scan: what this machine can measure, in a sentence, and what to do
 * when it cannot. Pure: machine, host facts and power state in, words out.
 */
export function energyPreflight(
  m: Machine,
  facts: HostFacts,
  options: { enabled: boolean; onBattery?: boolean; lowPowerMode?: boolean },
): Preflight {
  const name = machineName(m);
  const capable =
    !facts.virtualised &&
    ((m.platform === 'darwin' && !!m.appleSilicon && !(m.firefoxArchs && !m.firefoxArchs.includes('arm64'))) ||
      (m.platform === 'linux' && !!facts.linux?.pmu && (facts.linux.paranoid ?? 99) <= 0));

  if (!options.enabled) {
    return {
      level: 'off',
      lines: [capable ? `Energy: off (--no-energy). This ${name} can measure Firefox's energy: leave out --no-energy to include it.` : 'Energy: off (--no-energy).'],
    };
  }

  const conditions: string[] = [];
  if (m.platform === 'darwin' && !facts.virtualised) {
    if (options.lowPowerMode) conditions.push('Low Power Mode is on. It throttles the CPU and lowers measured energy: turn it off, and do not compare these runs with runs made with it off.');
    if (options.onBattery) conditions.push('Running on battery. Plug in, or compare these runs only with other runs on battery.');
  }

  if (facts.virtualised) {
    return {
      level: 'warn',
      lines: [
        `Energy: not measurable here. This is a virtual machine (${facts.hypervisor ?? 'hypervisor detected'}), and virtual machines do not pass power counters through.`,
        'Timing, network and CO2.js figures are still recorded. To measure energy, run on a physical Apple Silicon Mac or a bare-metal Linux PC (docs/local-energy.md).',
      ],
    };
  }

  if (m.platform === 'darwin') {
    if (m.appleSilicon && m.rosetta && m.firefoxArchs && !m.firefoxArchs.includes('arm64')) {
      return {
        level: 'warn',
        lines: [
          `Energy: this is an ${name}, but the Firefox installed is the Intel build, which runs translated under Rosetta. Energy has not been verified that way.`,
          'Install the Apple Silicon (arm64) build of Node (`node -p process.arch` prints arm64), then run `npm ci` and `npx playwright install firefox` again.',
          ...conditions,
        ],
      };
    }
    if (m.appleSilicon) {
      const rosetta = m.rosetta
        ? [`Node is the Intel build, running under Rosetta.${m.firefoxArchs ? ' Firefox is the Apple Silicon build, so what it measures is unaffected.' : ''} The Apple Silicon build of Node is faster.`]
        : [];
      return { level: conditions.length || rosetta.length ? 'note' : 'ok', lines: [`Energy: ${name}. Firefox measures the energy of its own processes here, with no setup.`, ...rosetta, ...conditions] };
    }
    return {
      level: 'note',
      lines: [
        `Energy: ${name}. Firefox reads the CPU package's energy, which covers every process on the machine, so close other applications.`,
        'This is supported by Firefox but not yet verified with this tool: the results will say whether energy was recorded.',
        ...conditions,
      ],
    };
  }

  if (m.platform === 'linux') {
    const l = facts.linux;
    if (!l?.pmu) {
      return {
        level: 'warn',
        lines: [`Energy: not measurable here. This ${name} exposes no RAPL energy counters: an Intel CPU, or AMD Zen with Linux 5.8 or later, is needed.`, 'Timing, network and CO2.js figures are still recorded.'],
      };
    }
    if ((l.paranoid ?? 99) > 0) {
      return {
        level: 'warn',
        lines: [
          `Energy: will not be measured on this ${name} yet. Its RAPL counters are there, but kernel.perf_event_paranoid is ${l.paranoid ?? 'unreadable'} and Firefox needs 0 or lower.`,
          'Stop now and run `sudo sysctl kernel.perf_event_paranoid=0` (it resets at reboot), then start the scan again.',
        ],
      };
    }
    return {
      level: 'ok',
      lines: [`Energy: ${name}, RAPL counters readable (${l.events.join(', ') || 'present'}). This measures the whole CPU package, every process on the machine, so close other applications.`],
    };
  }

  if (m.platform === 'win32') {
    return { level: 'note', lines: [`Energy: ${name}. Windows reports CPU package energy only on Windows 11 with a supported CPU: the results will say whether any was recorded.`] };
  }
  return { level: 'note', lines: [`Energy: no known power counters on ${name}: the results will say whether any were recorded.`] };
}
