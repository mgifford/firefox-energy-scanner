import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  EnergyAdapter,
  Availability,
  MeasurementContext,
  MeasurementHandle,
  EnergyAdapterMetadata,
} from './adapter.js';
import type { EnergyResult } from '../core/types.js';

const execFileAsync = promisify(execFile);

/**
 * macOS `powermetrics` adapter.
 *
 * Opt-in only. Verified on this machine that `sudo -n powermetrics` fails with
 * "a password is required", so making this the default would block unattended
 * runs on a password prompt. See docs/decision-record.md TDR-004.
 *
 * Scope is SYSTEM, not the browser: it answers a different question from the
 * Firefox Profiler adapter and is intended as a cross-check, not a substitute.
 */
export class PowermetricsAdapter implements EnergyAdapter {
  readonly id = 'macos-powermetrics';

  private samplers = new Map<string, { proc: ReturnType<typeof spawn>; chunks: string[]; startedAt: number }>();
  private counter = 0;

  metadata(): EnergyAdapterMetadata {
    return {
      id: this.id,
      description:
        'macOS powermetrics CPU/GPU power sampler. System-wide scope, requires elevated privileges.',
      scope: 'system',
      type: 'hardware-estimate',
      unitBasis:
        'powermetrics reports combined power in milliwatts; joules = mW/1000 * seconds.',
    };
  }

  async available(): Promise<Availability> {
    if (process.platform !== 'darwin') {
      return { available: false, reason: 'powermetrics is macOS-only.' };
    }
    try {
      // -n avoids an interactive password prompt; failure means we lack rights.
      await execFileAsync('sudo', ['-n', 'powermetrics', '--help'], { timeout: 5000 });
      return { available: true };
    } catch {
      return {
        available: false,
        needsPrivileges: true,
        reason:
          'powermetrics requires elevated privileges (sudo -n failed). Enable passwordless sudo for powermetrics to use this adapter.',
      };
    }
  }

  async start(context: MeasurementContext): Promise<MeasurementHandle> {
    const id = `pm${this.counter++}`;
    const startedAt = Date.now();
    const proc = spawn(
      'sudo',
      ['-n', 'powermetrics', '--samplers', 'cpu_power,gpu_power', '-i', '100', '-f', 'text'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: string[] = [];
    proc.stdout?.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
    this.samplers.set(id, { proc, chunks, startedAt });
    return { id, startedAt, label: context.label };
  }

  async stop(handle: MeasurementHandle): Promise<EnergyResult> {
    const entry = this.samplers.get(handle.id);
    const endedAt = Date.now();
    const durationMs = endedAt - handle.startedAt;
    const meta = this.metadata();

    const result: EnergyResult = {
      durationMs,
      measurementScope: meta.scope,
      measurementType: meta.type,
      attribution: 'time-window',
      adapterId: this.id,
    };
    if (!entry) return result;

    entry.proc.kill('SIGTERM');
    await new Promise((r) => entry.proc.once('close', r));
    this.samplers.delete(handle.id);

    const parsed = parsePowermetrics(entry.chunks.join(''));
    if (parsed.samples > 0) {
      const seconds = durationMs / 1000;
      result.averageWatts = parsed.averageMilliwatts / 1000;
      result.totalJoules = result.averageWatts * seconds;
      result.sampleCount = parsed.samples;
      if (parsed.cpuMilliwatts !== undefined) {
        result.cpuJoules = (parsed.cpuMilliwatts / 1000) * seconds;
      }
      if (parsed.gpuMilliwatts !== undefined) {
        result.gpuJoules = (parsed.gpuMilliwatts / 1000) * seconds;
      }
    }
    return result;
  }
}

export interface ParsedPowermetrics {
  samples: number;
  averageMilliwatts: number;
  cpuMilliwatts?: number;
  gpuMilliwatts?: number;
}

/**
 * Parse `powermetrics` text output.
 *
 * Extracted as a pure function so it can be tested without elevated
 * privileges, per the requirement that ordinary tests not need admin rights.
 */
export function parsePowermetrics(text: string): ParsedPowermetrics {
  const collect = (re: RegExp): number[] => {
    const out: number[] = [];
    for (const m of text.matchAll(re)) {
      const v = Number.parseFloat(m[1] ?? '');
      if (Number.isFinite(v)) out.push(v);
    }
    return out;
  };
  const mean = (xs: number[]): number | undefined =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;

  const combined = collect(/Combined Power \(CPU \+ GPU \+ ANE\):\s*([\d.]+)\s*mW/g);
  const cpu = collect(/CPU Power:\s*([\d.]+)\s*mW/g);
  const gpu = collect(/GPU Power:\s*([\d.]+)\s*mW/g);

  const cpuMean = mean(cpu);
  const gpuMean = mean(gpu);
  const combinedMean = mean(combined);

  // Fall back to CPU+GPU when the combined line is absent.
  const average =
    combinedMean ?? ((cpuMean ?? 0) + (gpuMean ?? 0) || undefined);

  return {
    samples: combined.length || Math.max(cpu.length, gpu.length),
    averageMilliwatts: average ?? 0,
    ...(cpuMean !== undefined ? { cpuMilliwatts: cpuMean } : {}),
    ...(gpuMean !== undefined ? { gpuMilliwatts: gpuMean } : {}),
  };
}
