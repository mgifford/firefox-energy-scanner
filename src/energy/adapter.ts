import type { EnergyResult } from '../core/types.js';

export interface Availability {
  available: boolean;
  reason?: string;
  /** Set when the adapter could work but needs privileges the process lacks. */
  needsPrivileges?: boolean;
}

export interface EnergyAdapterMetadata {
  id: string;
  description: string;
  scope: EnergyResult['measurementScope'];
  type: EnergyResult['measurementType'];
  /** Primary documentation backing the unit conversion. */
  unitBasis: string;
}

/** Opaque per-measurement handle returned by start(). */
export interface MeasurementHandle {
  id: string;
  startedAt: number;
  [key: string]: unknown;
}

export interface MeasurementContext {
  /** Label of the step being measured. */
  label: string;
  /** Firefox process id, when the adapter needs to scope to the browser. */
  browserPid?: number;
}

export interface EnergyAdapter {
  id: string;
  available(): Promise<Availability>;
  start(context: MeasurementContext): Promise<MeasurementHandle>;
  stop(handle: MeasurementHandle): Promise<EnergyResult>;
  metadata(): EnergyAdapterMetadata;
}
