import type { Page, BrowserContext } from 'playwright';

/**
 * Journey definition API.
 *
 * A journey describes a deterministic user task with explicitly named
 * measurement boundaries. This is the preferred mode for regression testing,
 * because a crawl visits different pages under different conditions and is a
 * poor basis for comparing two builds.
 */

export interface SetupArgs {
  page: Page;
  context: BrowserContext;
  baseUrl: string;
  env: NodeJS.ProcessEnv;
}

/** Wraps a block of work so it becomes a separately measured step. */
export type MeasureFn = (name: string, fn: () => Promise<void>) => Promise<void>;

export interface RunArgs {
  page: Page;
  context: BrowserContext;
  baseUrl: string;
  measure: MeasureFn;
  /** Resolves a relative route against the target base URL. */
  url: (path: string) => string;
  env: NodeJS.ProcessEnv;
}

export interface JourneyDefinition {
  name: string;
  description?: string;
  /**
   * Prerequisite state such as authentication. Setup runs OUTSIDE the measured
   * region so login cost is not attributed to the workload.
   */
  setup?: (args: SetupArgs) => Promise<void>;
  run: (args: RunArgs) => Promise<void>;
  teardown?: (args: SetupArgs) => Promise<void>;
}

export function defineJourney(def: JourneyDefinition): JourneyDefinition {
  if (!def.name) throw new Error('Journey requires a name');
  if (typeof def.run !== 'function') throw new Error(`Journey "${def.name}" requires a run() function`);
  return def;
}

/** Load a journey module from disk and validate its default export. */
export async function loadJourney(path: string): Promise<JourneyDefinition> {
  const resolved = path.startsWith('file:') ? path : `file://${path}`;
  const mod = (await import(resolved)) as { default?: unknown };
  const def = mod.default;
  if (!def || typeof def !== 'object') {
    throw new Error(`Journey file ${path} must have a default export from defineJourney()`);
  }
  const candidate = def as JourneyDefinition;
  if (!candidate.name || typeof candidate.run !== 'function') {
    throw new Error(`Journey file ${path} default export is not a valid journey definition`);
  }
  return candidate;
}
