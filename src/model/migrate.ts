/**
 * Reading results across schema versions.
 *
 * Version 1 results (before the component graph) are read as they are: no
 * field changes meaning. Migrating adds what version 2 derives from stored
 * data (page families when missing, and the component graph) and records
 * that it was migrated. Owned counts in a migrated graph are estimated, and
 * the graph says so. Nothing measured is recomputed or changed.
 */

import type { BenchmarkResult } from '../core/types.js';
import { SCHEMA_VERSION } from '../core/types.js';
import { buildFamilies } from '../analysis/families.js';
import { buildGraph } from './graph.js';

export interface Migrated {
  result: BenchmarkResult;
  /** The version the result was written with. */
  from: number;
  /** What was added. */
  added: string[];
}

export function migrateResult(input: BenchmarkResult): Migrated {
  const from = input.schemaVersion ?? 1;
  const result: BenchmarkResult = { ...input };
  const added: string[] = [];
  if (!result.families) {
    const families = buildFamilies(result.scenarios, result.sampling?.listed !== undefined ? { listed: result.sampling.listed } : {});
    if (families) {
      result.families = families;
      added.push('families');
    }
  }
  if (!result.graph) {
    const graph = buildGraph(result);
    if (graph) {
      result.graph = graph;
      added.push('graph');
    }
  }
  if (from < SCHEMA_VERSION) {
    result.schemaVersion = SCHEMA_VERSION;
    result.migratedFrom = from;
  }
  return { result, from, added };
}
