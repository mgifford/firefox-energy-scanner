/** Descriptive statistics. Median is the headline metric throughout. */

export interface Summary {
  count: number;
  median: number;
  mean: number;
  min: number;
  max: number;
  stdDev: number;
  p25: number;
  p75: number;
  p95: number;
  iqr: number;
}

/** Linear-interpolated percentile (p in [0,1]) over a sorted copy. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function summarize(values: number[]): Summary {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) {
    return {
      count: 0, median: Number.NaN, mean: Number.NaN, min: Number.NaN,
      max: Number.NaN, stdDev: Number.NaN, p25: Number.NaN,
      p75: Number.NaN, p95: Number.NaN, iqr: Number.NaN,
    };
  }
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  // Sample standard deviation (n-1); undefined for a single observation.
  const stdDev =
    clean.length > 1
      ? Math.sqrt(clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1))
      : 0;
  const p25 = percentile(clean, 0.25);
  const p75 = percentile(clean, 0.75);
  return {
    count: clean.length,
    median: percentile(clean, 0.5),
    mean,
    min: Math.min(...clean),
    max: Math.max(...clean),
    stdDev,
    p25,
    p75,
    p95: percentile(clean, 0.95),
    iqr: p75 - p25,
  };
}

/** Spearman rank correlation, preferred for monotonic / non-normal data. */
export function spearman(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return Number.NaN;
  const rank = (values: number[]): number[] => {
    const indexed = values.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++;
      // Average rank across ties.
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avg;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs.slice(0, n));
  const ry = rank(ys.slice(0, n));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? Number.NaN : num / den;
}

export interface ComparisonResult {
  a: Summary;
  b: Summary;
  absoluteDifference: number;
  percentDifference: number;
  medianDifference: number;
  /** True only when both groups have enough runs to be worth interpreting. */
  sufficientSamples: boolean;
  qualification?: string;
}

const MIN_RUNS_FOR_CONFIDENCE = 10;

/** Compare two sets of measurements. Median-based, with explicit qualification. */
export function compare(aValues: number[], bValues: number[]): ComparisonResult {
  const a = summarize(aValues);
  const b = summarize(bValues);
  const medianDifference = b.median - a.median;
  const percentDifference = a.median === 0 ? Number.NaN : (medianDifference / a.median) * 100;
  const sufficientSamples =
    a.count >= MIN_RUNS_FOR_CONFIDENCE && b.count >= MIN_RUNS_FOR_CONFIDENCE;

  return {
    a,
    b,
    absoluteDifference: medianDifference,
    percentDifference,
    medianDifference,
    sufficientSamples,
    ...(sufficientSamples
      ? {}
      : {
          qualification:
            `Fewer than ${MIN_RUNS_FOR_CONFIDENCE} runs per side (a=${a.count}, b=${b.count}). ` +
            'Treat this as indicative only; no significance is claimed.',
        }),
  };
}

/** Deterministic PRNG (mulberry32) seeded from a string. */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic interleaved ordering across N targets.
 *
 * Each round contains every target exactly once, shuffled within the round.
 * Grouping runs by target (all of A, then all of B) would confound drift in
 * thermal state, network, or server cache with the target being measured.
 * Balancing per round keeps every target spread evenly across the session.
 */
export function interleavedOrderN(
  targets: string[],
  rounds: number,
  seed: string,
): string[] {
  if (targets.length === 0) return [];
  const rand = seededRandom(seed);
  const order: string[] = [];
  for (let r = 0; r < rounds; r++) {
    const round = [...targets];
    // Fisher-Yates within the round.
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [round[i], round[j]] = [round[j]!, round[i]!];
    }
    order.push(...round);
  }
  return order;
}

/**
 * Deterministic interleaved A/B ordering from a seed.
 *
 * Runs must not be grouped (all A then all B) because drift in thermal state,
 * network, or server cache would be confounded with the target.
 */
export function interleavedOrder(runs: number, seed: string): ('a' | 'b')[] {
  // Small deterministic PRNG (mulberry32) seeded from a string hash.
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  const rand = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Build balanced pairs, then shuffle within each pair so neither target is
  // systematically favoured by position.
  const order: ('a' | 'b')[] = [];
  for (let i = 0; i < runs; i++) {
    order.push(...(rand() < 0.5 ? (['a', 'b'] as const) : (['b', 'a'] as const)));
  }
  return order;
}
