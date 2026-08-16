/**
 * Attribute browser work to categories, so a result can say *what* the browser
 * spent effort on rather than only *how much* it spent overall.
 *
 * ## What this is, and what it is not
 *
 * Firefox's power counter is whole-process. From
 * `tools/profiler/core/PowerCounters-mac-arm64.cpp`:
 *
 *   task_info(mach_task_self(), TASK_POWER_INFO_V2, ...)
 *
 * `mach_task_self()` is the process. There is no per-element, per-resource or
 * per-category power counter anywhere in the platform, so joules **cannot** be
 * measured for "images" or "your analytics script" directly.
 *
 * What the profile does carry is per-sample CPU time (`threadCPUDelta`) and a
 * category on every stack frame. This module sums CPU time per category and
 * apportions the measured energy in proportion:
 *
 *   categoryJoules = measuredJoules * (categoryCpuTime / totalCpuTime)
 *
 * That is an **apportionment under a stated assumption** — that a millisecond
 * of CPU in layout costs about the same as a millisecond in JavaScript. It is
 * useful for ranking where the work went. It is not a measurement, every field
 * is labelled `apportioned`, and the assumption is reported alongside.
 *
 * The assumption's main known weakness: GPU-heavy work (compositing,
 * animation) draws power without proportionate CPU time, so `Graphics` is
 * likely under-attributed. This is documented rather than silently corrected.
 */

export interface CategoryCpu {
  category: string;
  cpuMs: number;
  share: number;
  /** Energy apportioned by CPU share. Never a direct measurement. */
  apportionedJoules?: number;
}

export interface AttributionResult {
  categories: CategoryCpu[];
  totalCpuMs: number;
  /**
   * How shares were weighted. 'cpu-time' needs the profiler's `cpu` feature;
   * without it sample rows carry no threadCPUDelta and we fall back to
   * counting samples, which is coarser but still indicative.
   */
  basis: 'cpu-time' | 'sample-count';
  /** Total energy the apportionment was distributed across. */
  measuredJoules?: number;
  method: 'cpu-time-apportioned';
  assumption: string;
  /** Sample count backing the attribution; low counts are unreliable. */
  sampleCount: number;
}

interface ProfileThread {
  name?: string;
  samples: {
    schema: Record<string, number>;
    data: (number | null)[][];
  };
  stackTable?: { schema: Record<string, number>; data: (number | null)[][] };
  frameTable?: { schema: Record<string, number>; data: (number | null)[][] };
}

interface ProfileNode {
  meta: { startTime: number; categories?: { name: string }[] };
  threads?: ProfileThread[];
  processes?: ProfileNode[];
}

/** Categories that represent real page work worth reporting. */
const REPORTABLE = new Set([
  'Layout',
  'JavaScript',
  'Graphics',
  'GC / CC',
  'DOM',
  'Network',
  'Media',
  'Other',
]);

/**
 * Resolve the category of a stack by walking to its leaf frame.
 *
 * Gecko stores a category on frames; the leaf is the most specific answer for
 * "what was the browser doing at this instant".
 */
function leafCategory(
  stackIndex: number | null,
  stackTable: NonNullable<ProfileThread['stackTable']>,
  frameTable: NonNullable<ProfileThread['frameTable']>,
  categoryNames: string[],
): string | undefined {
  if (stackIndex === null || stackIndex === undefined) return undefined;

  const frameCol = stackTable.schema.frame;
  const prefixCol = stackTable.schema.prefix;
  // Some profiles carry a category on the stack table; many do not, in which
  // case it lives on the frame (frameTable.schema.category).
  const stackCatCol = stackTable.schema.category;
  const frameCatCol = frameTable.schema.category;

  const categoryAt = (index: number): string | undefined => {
    const row = stackTable.data[index];
    if (!row) return undefined;

    if (stackCatCol !== undefined) {
      const c = row[stackCatCol];
      if (c !== null && c !== undefined) return categoryNames[c as number];
    }
    if (frameCol === undefined || frameCatCol === undefined) return undefined;

    const frameIndex = row[frameCol];
    if (frameIndex === null || frameIndex === undefined) return undefined;
    const frameRow = frameTable.data[frameIndex as number];
    // Frame rows are often truncated before the category column.
    if (!frameRow || frameRow.length <= frameCatCol) return undefined;
    const c = frameRow[frameCatCol];
    if (c === null || c === undefined) return undefined;
    return categoryNames[c as number];
  };

  // Walk from the leaf towards the root until a frame carries a category.
  // The leaf is the most specific answer, but truncated rows are common, so
  // an ancestor's category is a better answer than giving up.
  let index: number | null = stackIndex;
  let depth = 0;
  while (index !== null && depth < 128) {
    const category = categoryAt(index);
    if (category !== undefined) return category;
    if (prefixCol === undefined) break;
    const parent: number | null | undefined = stackTable.data[index]?.[prefixCol] as
      | number
      | null
      | undefined;
    index = parent ?? null;
    depth++;
  }
  return undefined;
}

/**
 * Sum CPU time per category across all threads and processes in a window.
 *
 * `threadCPUDelta` is CPU time consumed since the previous sample, in
 * microseconds on macOS (see `meta.sampleUnits.threadCPUDelta`).
 */
export function attributeCpuTime(
  profile: unknown,
  startEpochMs: number,
  endEpochMs: number,
): {
  byCategory: Map<string, number>;
  totalCpuMs: number;
  sampleCount: number;
  basis: 'cpu-time' | 'sample-count';
} {
  const byCategory = new Map<string, number>();
  let totalCpuMs = 0;
  let sampleCount = 0;
  let sawCpuTime = false;

  const root = profile as ProfileNode | undefined;
  const categoryNames = (root?.meta?.categories ?? []).map((c) => c.name);

  const visit = (node: ProfileNode | undefined): void => {
    if (!node?.meta) return;
    const origin = node.meta.startTime;

    for (const thread of node.threads ?? []) {
      const { samples, stackTable, frameTable } = thread;
      if (!samples?.data || !stackTable || !frameTable) continue;

      const timeCol = samples.schema.time;
      const stackCol = samples.schema.stack;
      const cpuCol = samples.schema.threadCPUDelta;
      if (timeCol === undefined) continue;

      const relStart = startEpochMs - origin;
      const relEnd = endEpochMs - origin;

      for (const row of samples.data) {
        const t = row[timeCol];
        if (t === null || t === undefined) continue;
        if (!(t > relStart && t <= relEnd)) continue;

        // threadCPUDelta is only present when the 'cpu' feature was enabled.
        // Otherwise weight each sample equally: coarser, but still shows where
        // the browser was spending its time.
        const cpuRaw = cpuCol === undefined ? undefined : row[cpuCol];
        let cpuMs: number;
        if (cpuRaw === null || cpuRaw === undefined) {
          cpuMs = 1; // one "unit" per sample
        } else {
          cpuMs = (cpuRaw as number) / 1000; // microseconds -> milliseconds
          if (!Number.isFinite(cpuMs) || cpuMs <= 0) continue;
          sawCpuTime = true;
        }

        const category =
          leafCategory(
            stackCol !== undefined ? (row[stackCol] as number | null) : null,
            stackTable,
            frameTable,
            categoryNames,
          ) ?? 'Other';

        // Idle time is not work and must not dilute the shares.
        if (category === 'Idle') continue;

        const key = REPORTABLE.has(category) ? category : 'Other';
        byCategory.set(key, (byCategory.get(key) ?? 0) + cpuMs);
        totalCpuMs += cpuMs;
        sampleCount++;
      }
    }

    for (const child of node.processes ?? []) visit(child);
  };

  visit(root);
  return {
    byCategory,
    totalCpuMs,
    sampleCount,
    basis: sawCpuTime ? ('cpu-time' as const) : ('sample-count' as const),
  };
}

export const APPORTIONMENT_ASSUMPTION =
  'Energy is apportioned by CPU time share, assuming a millisecond of CPU costs ' +
  'roughly the same in each category. GPU-heavy work (compositing, animation) draws ' +
  'power without proportionate CPU time, so Graphics is likely under-attributed. ' +
  'These are apportioned figures, not per-category measurements.';

/** Build the category breakdown for one measured window. */
export function attributeEnergy(
  profile: unknown,
  startEpochMs: number,
  endEpochMs: number,
  measuredJoules?: number,
): AttributionResult {
  const { byCategory, totalCpuMs, sampleCount, basis } = attributeCpuTime(
    profile,
    startEpochMs,
    endEpochMs,
  );

  const categories: CategoryCpu[] = [...byCategory.entries()]
    .map(([category, cpuMs]) => {
      const share = totalCpuMs > 0 ? cpuMs / totalCpuMs : 0;
      return {
        category,
        cpuMs,
        share,
        ...(measuredJoules !== undefined && totalCpuMs > 0
          ? { apportionedJoules: measuredJoules * share }
          : {}),
      };
    })
    .sort((a, b) => b.cpuMs - a.cpuMs);

  return {
    categories,
    totalCpuMs,
    ...(measuredJoules !== undefined ? { measuredJoules } : {}),
    method: 'cpu-time-apportioned',
    basis,
    assumption:
      basis === 'cpu-time'
        ? APPORTIONMENT_ASSUMPTION
        : APPORTIONMENT_ASSUMPTION +
          ' CPU time was unavailable in this profile, so shares are weighted by sample ' +
          'count instead — coarser, and it over-weights cheap frequent samples.',
    sampleCount,
  };
}
