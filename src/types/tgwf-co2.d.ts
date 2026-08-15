/**
 * Local type declarations for @tgwf/co2 (v0.19.0), which ships no types.
 *
 * These signatures were verified empirically against the installed package
 * rather than assumed. See docs/decision-record.md TDR-005.
 */
declare module '@tgwf/co2' {
  export interface Co2Options {
    model?: 'swd' | '1byte';
    results?: 'segment';
    rating?: boolean;
  }

  /** Returned when constructed with `results: 'segment'` (swd model only). */
  export interface SegmentedResult {
    dataCenterOperationalCO2e: number;
    networkOperationalCO2e: number;
    consumerDeviceOperationalCO2e: number;
    dataCenterEmbodiedCO2e: number;
    networkEmbodiedCO2e: number;
    consumerDeviceEmbodiedCO2e: number;
    totalEmbodiedCO2e: number;
    totalOperationalCO2e: number;
    dataCenterCO2e: number;
    networkCO2e: number;
    consumerDeviceCO2e: number;
    total: number;
  }

  export interface TraceResult {
    co2: number | SegmentedResult;
    green: boolean;
    variables: {
      description: string;
      bytes: number;
      gridIntensity: Record<string, unknown>;
      greenHostingFactor: number;
    };
  }

  export class co2 {
    constructor(options?: Co2Options);
    perByte(bytes: number, green?: boolean): number | SegmentedResult;
    perVisit(bytes: number, green?: boolean): number | SegmentedResult;
    perByteTrace(bytes: number, green?: boolean): TraceResult;
    perVisitTrace(bytes: number, green?: boolean): TraceResult;
  }

  export const hosting: {
    check(domain: string | string[], userAgent?: string): Promise<boolean | string[]>;
  };

  export const averageIntensity: { data: Record<string, number>; type: string };
  export const marginalIntensity: { data: Record<string, number>; type: string };
}
