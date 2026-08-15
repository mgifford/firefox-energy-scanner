import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EnergyAdapter,
  Availability,
  MeasurementContext,
  MeasurementHandle,
  EnergyAdapterMetadata,
} from './adapter.js';
import type { EnergyResult } from '../core/types.js';
import { collectPowerUnits, energyInWindow, type PowerUnit } from './gecko-profile.js';

/**
 * Environment variables that enable session-scoped profiling.
 *
 * Per-step profiler control is not possible: nsIProfiler is chrome-privileged
 * and Playwright exposes no chrome-context evaluation for Firefox
 * (newBrowserCDPSession is Chromium-only). We therefore profile the whole
 * session and slice the power counter by wall-clock window.
 * See docs/decision-record.md TDR-002.
 */
export interface ProfilerLaunchEnv {
  MOZ_PROFILER_STARTUP: string;
  MOZ_PROFILER_STARTUP_FEATURES: string;
  MOZ_PROFILER_STARTUP_INTERVAL: string;
  MOZ_PROFILER_STARTUP_ENTRIES: string;
  MOZ_PROFILER_SHUTDOWN: string;
}

export interface FirefoxProfilerOptions {
  /**
   * Sampling interval in ms. Higher values reduce observer overhead.
   * Power counters are read per sample, so this also sets energy resolution.
   */
  intervalMs?: number;
  /** Profile buffer entries. Long sessions need a large buffer. */
  entries?: number;
  /**
   * Extra profiler features. 'power' is always included. Adding stack-sampling
   * features increases overhead and is reserved for diagnostic profile runs.
   */
  features?: string[];
  /** Keep the raw .json profile after parsing. */
  retainProfile?: boolean;
}

export async function createProfileOutputPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'web-energy-profile-'));
  return join(dir, 'profile.json');
}

/**
 * Build the environment that must be passed to firefox.launch() for this
 * adapter to collect anything. The caller owns browser launch, so the adapter
 * cannot do this itself.
 */
export function profilerLaunchEnv(
  outputPath: string,
  options: FirefoxProfilerOptions = {},
): ProfilerLaunchEnv {
  const features = new Set(['power', ...(options.features ?? [])]);
  return {
    MOZ_PROFILER_STARTUP: '1',
    MOZ_PROFILER_STARTUP_FEATURES: [...features].join(','),
    MOZ_PROFILER_STARTUP_INTERVAL: String(options.intervalMs ?? 10),
    MOZ_PROFILER_STARTUP_ENTRIES: String(options.entries ?? 20_000_000),
    MOZ_PROFILER_SHUTDOWN: outputPath,
  };
}

/**
 * Energy adapter backed by the Gecko Profiler power counters.
 *
 * Lifecycle differs from a naive start/stop adapter: the profile only exists
 * after the browser exits, so start()/stop() record timestamps, and the actual
 * energy values are resolved by finalize() once the profile has been written.
 */
export class FirefoxProfilerAdapter implements EnergyAdapter {
  readonly id = 'firefox-profiler';

  private units: PowerUnit[] | null = null;
  private windows = new Map<string, { label: string; start: number; end?: number }>();
  private counter = 0;

  constructor(
    private readonly outputPath: string,
    private readonly options: FirefoxProfilerOptions = {},
  ) {}

  metadata(): EnergyAdapterMetadata {
    return {
      id: this.id,
      description:
        'Gecko Profiler per-process power counters, summed across Firefox parent and content processes.',
      scope: 'process',
      type: 'hardware-estimate',
      unitBasis:
        'Counter samples are picowatt-hours; joules = pWh * 1e-12 * 3600 (firefox-devtools/profiler TrackCounterTooltipFormat.ts).',
    };
  }

  async available(): Promise<Availability> {
    // Power counters are exposed on Apple Silicon macOS and Windows 11.
    // On other platforms the profiler still runs but emits no power category,
    // which finalize() surfaces as "no power counters found".
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      return { available: true };
    }
    if (process.platform === 'win32') {
      return { available: true };
    }
    return {
      available: false,
      reason:
        `Firefox power counters are not expected on ${process.platform}/${process.arch}. ` +
        'Verified support: macOS on Apple Silicon, and Windows 11.',
    };
  }

  async start(context: MeasurementContext): Promise<MeasurementHandle> {
    const id = `w${this.counter++}`;
    const startedAt = Date.now();
    this.windows.set(id, { label: context.label, start: startedAt });
    return { id, startedAt };
  }

  /**
   * Closes the measurement window. Energy is not available yet — the profile is
   * written at browser shutdown — so this returns a placeholder that finalize()
   * later replaces. Callers should use finalize() results for reporting.
   */
  async stop(handle: MeasurementHandle): Promise<EnergyResult> {
    const w = this.windows.get(handle.id);
    const endedAt = Date.now();
    if (w) w.end = endedAt;
    const meta = this.metadata();
    return {
      durationMs: endedAt - handle.startedAt,
      measurementScope: meta.scope,
      measurementType: meta.type,
      attribution: 'time-window',
      adapterId: this.id,
    };
  }

  /**
   * Parse the profile written at browser shutdown and resolve every window.
   * Must be called after the browser has fully closed.
   */
  async finalize(): Promise<Map<string, EnergyResult>> {
    const results = new Map<string, EnergyResult>();
    if (!existsSync(this.outputPath)) return results;

    const raw = await readFile(this.outputPath, 'utf8');
    let profile: unknown;
    try {
      profile = JSON.parse(raw);
    } catch {
      return results;
    }
    this.units = collectPowerUnits(profile);

    const meta = this.metadata();
    for (const [id, w] of this.windows) {
      if (w.end === undefined) continue;
      const durationMs = w.end - w.start;
      const result: EnergyResult = {
        durationMs,
        measurementScope: meta.scope,
        measurementType: meta.type,
        attribution: 'time-window',
        adapterId: this.id,
      };
      if (this.units.length > 0) {
        const { joules, sampleCount } = energyInWindow(this.units, w.start, w.end);
        result.totalJoules = joules;
        result.sampleCount = sampleCount;
        if (durationMs > 0) {
          result.averageWatts = joules / (durationMs / 1000);
        }
      }
      results.set(w.label, result);
    }

    if (!this.options.retainProfile) {
      await unlink(this.outputPath).catch(() => {});
    }
    return results;
  }

  /** True when the parsed profile contained at least one power counter. */
  hasPowerData(): boolean {
    return (this.units?.length ?? 0) > 0;
  }
}
