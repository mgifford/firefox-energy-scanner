import { describe, it, expect } from 'vitest';
import { estimateCo2, co2jsVersion, isSupportedModel } from '../src/core/co2.js';

describe('CO2.js integration', () => {
  it('reports the installed library version in every result', () => {
    const r = estimateCo2(1_000_000, { model: 'swd' });
    expect(r.library).toBe('@tgwf/co2');
    expect(r.libraryVersion).toBe(co2jsVersion());
    expect(r.libraryVersion).not.toBe('unknown');
  });

  it('records the model used so runs are reproducible', () => {
    expect(estimateCo2(1000, { model: 'swd' }).model).toBe('swd');
    expect(estimateCo2(1000, { model: '1byte' }).model).toBe('1byte');
  });

  it('scales with bytes', () => {
    const small = estimateCo2(1000, { model: 'swd' }).estimatedGrams;
    const large = estimateCo2(1_000_000, { model: 'swd' }).estimatedGrams;
    expect(large).toBeGreaterThan(small);
  });

  it('exposes the device segment separately from the total', () => {
    const r = estimateCo2(1_000_000, { model: 'swd' });
    expect(r.consumerDeviceGrams).toBeDefined();
    expect(r.networkGrams).toBeDefined();
    expect(r.dataCenterGrams).toBeDefined();
    // The device segment is the part that overlaps measured client energy, so
    // it must be strictly smaller than the whole-boundary total.
    expect(r.consumerDeviceGrams!).toBeLessThan(r.estimatedGrams);
  });

  it('yields lower emissions for green hosting', () => {
    const grey = estimateCo2(1_000_000, { model: 'swd', greenHosting: false });
    const green = estimateCo2(1_000_000, { model: 'swd', greenHosting: true });
    expect(green.estimatedGrams).toBeLessThan(grey.estimatedGrams);
    expect(green.greenHosting).toBe(true);
    expect(green.greenHostingChecked).toBe(true);
  });

  it('marks green hosting as unchecked when not supplied', () => {
    const r = estimateCo2(1000, { model: 'swd' });
    expect(r.greenHostingChecked).toBe(false);
    expect(r.greenHosting).toBe(false);
  });

  it('validates model identifiers', () => {
    expect(isSupportedModel('swd')).toBe(true);
    expect(isSupportedModel('1byte')).toBe(true);
    expect(isSupportedModel('sustainable-web-design')).toBe(false);
  });
});
