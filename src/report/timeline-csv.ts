import type { TimelineAnalysis } from '../energy/spike-analysis.js';

/**
 * One row per bin: time, samples, energy and power, the phase, and the
 * interval it belongs to. Empty cells are values that were not measured
 * (no sample, or power not derivable), never zeros.
 */
const COLUMNS = ['bin', 'start_ms', 'end_ms', 'samples', 'energy_j', 'average_power_w', 'phase', 'step', 'warmup', 'flags', 'interval'] as const;

function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function timelineCsv(a: TimelineAnalysis): string {
  const t = a.timeline;
  const inInterval = (start: number, end: number) => a.spikes.intervals.find((i) => start >= i.startMs && end <= i.endMs)?.id;
  const lines = [COLUMNS.join(',')];
  for (const b of t.bins) {
    const p = b.phase !== undefined ? t.phases[b.phase] : undefined;
    const row: Record<(typeof COLUMNS)[number], unknown> = {
      bin: b.index,
      start_ms: b.startMs,
      end_ms: b.endMs,
      samples: b.samples,
      energy_j: b.energyJ === null ? undefined : +b.energyJ.toPrecision(6),
      average_power_w: b.averagePowerW === null ? undefined : +b.averagePowerW.toPrecision(6),
      phase: p?.kind ?? 'unmeasured',
      step: p?.label,
      warmup: p?.warmup,
      flags: b.flags?.join(' '),
      interval: inInterval(b.startMs, b.endMs),
    };
    lines.push(COLUMNS.map((k) => cell(row[k])).join(','));
  }
  return lines.join('\n') + '\n';
}
