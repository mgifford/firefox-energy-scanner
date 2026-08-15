import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import type { EnvironmentInfo } from '../core/types.js';
import { co2jsVersion } from '../core/co2.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export function playwrightVersion(): string {
  try {
    const entry = require.resolve('playwright');
    const marker = `${'node_modules'}/playwright/`;
    const idx = entry.indexOf(marker);
    if (idx !== -1) {
      const manifest = `${entry.slice(0, idx + marker.length)}package.json`;
      return JSON.parse(readFileSync(manifest, 'utf8')).version as string;
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

export interface PowerState {
  onBattery?: boolean;
  batteryPercent?: number;
  /**
   * macOS Low Power Mode. It throttles CPU frequency and therefore suppresses
   * measured energy, so runs made with it on are not comparable to runs with
   * it off.
   */
  lowPowerMode?: boolean;
}

/** Read power source on macOS. Power state materially affects energy behaviour. */
export async function readPowerState(): Promise<PowerState> {
  if (process.platform !== 'darwin') return {};
  const state: PowerState = {};

  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'ps'], { timeout: 4000 });
    state.onBattery = /Now drawing from 'Battery Power'/.test(stdout);
    const pct = /(\d+)%/.exec(stdout);
    if (pct) state.batteryPercent = Number.parseInt(pct[1]!, 10);
  } catch {
    /* power source unavailable */
  }

  try {
    const { stdout } = await execFileAsync('pmset', ['-g'], { timeout: 4000 });
    const match = /^\s*lowpowermode\s+(\d+)/m.exec(stdout);
    if (match) state.lowPowerMode = match[1] === '1';
  } catch {
    /* low power mode unavailable */
  }

  return state;
}

async function machineModel(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.model'], { timeout: 4000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export interface EnvOptions {
  energyAdapter: string;
  headed: boolean;
  viewport: { width: number; height: number };
  firefoxVersion?: string;
  collectHostname?: boolean;
}

export async function collectEnvironment(options: EnvOptions): Promise<EnvironmentInfo> {
  const power = await readPowerState();
  const model = await machineModel();

  return {
    timestamp: new Date().toISOString(),
    os: process.platform,
    osVersion: os.release(),
    architecture: process.arch,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    ...(model ? { machineModel: model } : {}),
    ...(options.firefoxVersion ? { firefoxVersion: options.firefoxVersion } : {}),
    playwrightVersion: playwrightVersion(),
    co2jsVersion: co2jsVersion(),
    energyAdapter: options.energyAdapter,
    headed: options.headed,
    viewport: options.viewport,
    ...power,
    // Hostname is identifying data and is off by default.
    ...(options.collectHostname ? { hostname: os.hostname() } : {}),
  };
}
