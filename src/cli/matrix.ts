import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { fingerprint, triage, type PayloadFingerprint } from './triage.js';

/**
 * Multi-target comparison.
 *
 * Comparing patch A against patch B directly is confounded: two merge requests
 * touch different code on different branches, so any difference reflects
 * everything that differs between them, not the change under test. The
 * defensible shape is a shared baseline — measure core-head once, then each
 * patch against it, and rank the patches by their difference from that common
 * reference.
 */

const targetSchema = z
  .object({
    url: z.string().url(),
    label: z.string(),
    issue: z.string().optional(),
    mr: z.string().optional(),
    baseline: z.boolean().optional(),
  })
  .strict();

export const matrixSchema = z
  .object({
    targets: z.array(targetSchema).min(2),
  })
  .strict();

export type MatrixTarget = z.infer<typeof targetSchema>;
export type MatrixSpec = z.infer<typeof matrixSchema>;

export async function loadMatrix(path: string): Promise<MatrixSpec> {
  const spec = matrixSchema.parse(parseYaml(await readFile(path, 'utf8')));

  const baselines = spec.targets.filter((t) => t.baseline);
  if (baselines.length > 1) {
    throw new Error(
      `Matrix defines ${baselines.length} baselines; exactly one target may set "baseline: true".`,
    );
  }
  const labels = new Set<string>();
  for (const t of spec.targets) {
    if (labels.has(t.label)) throw new Error(`Duplicate target label: ${t.label}`);
    labels.add(t.label);
  }
  return spec;
}

/** The declared baseline, or the first target when none is marked. */
export function baselineOf(spec: MatrixSpec): MatrixTarget {
  return spec.targets.find((t) => t.baseline) ?? spec.targets[0]!;
}

export interface TriageRow {
  target: MatrixTarget;
  fingerprint: PayloadFingerprint;
  differsFromBaseline: boolean;
  inconclusive: boolean;
  summary: string;
}

/**
 * Pre-screen every target against the baseline before spending time measuring.
 * Targets whose delivered payload matches the baseline cannot differ in
 * client-side energy.
 */
export async function triageMatrix(
  spec: MatrixSpec,
  path: string | undefined,
): Promise<TriageRow[]> {
  const baseline = baselineOf(spec);
  const resolve = (t: MatrixTarget): string =>
    path ? new URL(path, t.url).toString() : t.url;

  const fingerprints = await Promise.all(spec.targets.map((t) => fingerprint(resolve(t))));
  const baseIndex = spec.targets.indexOf(baseline);
  const baseFp = fingerprints[baseIndex]!;

  return spec.targets.map((target, i) => {
    const fp = fingerprints[i]!;
    if (target === baseline) {
      return {
        target,
        fingerprint: fp,
        differsFromBaseline: false,
        inconclusive: fp.status < 200 || fp.status >= 300 || Boolean(fp.error),
        summary: 'baseline',
      };
    }
    const verdict = triage(baseFp, fp);
    const inconclusive = verdict.reasons.some((r) => r.startsWith('Inconclusive'));
    const parts: string[] = [];
    if (!verdict.scriptsIdentical) {
      parts.push(`scripts ${verdict.addedScripts.length}+/${verdict.removedScripts.length}-`);
    }
    if (!verdict.stylesIdentical) {
      parts.push(`styles ${verdict.addedStyles.length}+/${verdict.removedStyles.length}-`);
    }
    if (!verdict.htmlIdentical) {
      parts.push(`html ${verdict.byteDelta >= 0 ? '+' : ''}${verdict.byteDelta}B`);
    }
    return {
      target,
      fingerprint: fp,
      differsFromBaseline: verdict.worthMeasuring,
      inconclusive,
      summary: inconclusive
        ? 'inconclusive'
        : parts.length > 0
          ? parts.join(', ')
          : 'identical payload',
    };
  });
}
