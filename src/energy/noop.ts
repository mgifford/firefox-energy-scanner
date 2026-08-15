import type {
  EnergyAdapter,
  Availability,
  MeasurementContext,
  MeasurementHandle,
  EnergyAdapterMetadata,
} from './adapter.js';
import type { EnergyResult } from '../core/types.js';

/**
 * Fallback adapter used when no energy source is available.
 *
 * It records duration only. It deliberately emits NO joules, watts, or any
 * other energy field: fabricating an energy number, or deriving one from a
 * proxy such as CPU time, is explicitly out of scope for this project.
 */
export class NoopAdapter implements EnergyAdapter {
  readonly id = 'noop';
  private counter = 0;

  metadata(): EnergyAdapterMetadata {
    return {
      id: this.id,
      description:
        'No energy measurement. Timing is still recorded; no energy values are produced.',
      scope: 'proxy',
      type: 'proxy',
      unitBasis: 'None. This adapter never reports energy units.',
    };
  }

  async available(): Promise<Availability> {
    return { available: true };
  }

  async start(_context: MeasurementContext): Promise<MeasurementHandle> {
    return { id: `noop${this.counter++}`, startedAt: Date.now() };
  }

  async stop(handle: MeasurementHandle): Promise<EnergyResult> {
    const meta = this.metadata();
    return {
      durationMs: Date.now() - handle.startedAt,
      measurementScope: meta.scope,
      measurementType: meta.type,
      attribution: 'time-window',
      adapterId: this.id,
    };
  }
}
