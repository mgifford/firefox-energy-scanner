import { describe, it, expect } from 'vitest';
import { validateConfig, defaultConfig, formatConfigError } from '../src/core/config.js';

describe('config validation', () => {
  it('produces usable defaults from an empty config', () => {
    const c = defaultConfig();
    expect(c.benchmark.runs).toBe(10);
    expect(c.benchmark.warmups).toBe(3);
    expect(c.energy.adapter).toBe('auto');
    expect(c.co2.model).toBe('swd');
    expect(c.browser.name).toBe('firefox');
  });

  it('rejects unknown top-level keys rather than ignoring them', () => {
    expect(() => validateConfig({ nonsense: true })).toThrow();
  });

  it('rejects unknown nested keys', () => {
    expect(() => validateConfig({ benchmark: { runs: 5, typo_key: 1 } })).toThrow();
  });

  it('rejects an unsupported CO2 model', () => {
    expect(() => validateConfig({ co2: { model: 'made-up-model' } })).toThrow();
  });

  it('rejects a non-URL target', () => {
    expect(() => validateConfig({ target: { url: 'not-a-url' } })).toThrow();
  });

  it('rejects negative run counts', () => {
    expect(() => validateConfig({ benchmark: { runs: 0 } })).toThrow();
  });

  it('accepts a full realistic configuration', () => {
    const c = validateConfig({
      target: { url: 'https://example.tugboatqa.com', label: 'core-head', commit: 'abc123' },
      browser: { name: 'firefox', headed: true, viewport: { width: 1440, height: 900 } },
      auth: { type: 'drupal', username_env: 'DRUPAL_USERNAME', password_env: 'DRUPAL_PASSWORD' },
      benchmark: { warmups: 10, runs: 30, settle_ms: 1500, cache_mode: 'warm' },
      crawl: { enabled: false, max_pages: 100, same_origin: true, include: ['^/admin'] },
      energy: { adapter: 'auto', baseline: true },
      co2: { enabled: true, model: 'swd' },
    });
    expect(c.target?.label).toBe('core-head');
    expect(c.benchmark.runs).toBe(30);
  });

  it("rejects 'sustainable-web-design' since the library's identifier is 'swd'", () => {
    // Guards against the config example in the brief being copied verbatim.
    expect(() => validateConfig({ co2: { model: 'sustainable-web-design' } })).toThrow();
  });

  it('accepts the documented model identifiers', () => {
    expect(validateConfig({ co2: { model: 'swd' } }).co2.model).toBe('swd');
    expect(validateConfig({ co2: { model: '1byte' } }).co2.model).toBe('1byte');
  });

  it('formats errors with the offending path', () => {
    try {
      validateConfig({ benchmark: { runs: -1 } });
      expect.unreachable();
    } catch (err) {
      expect(formatConfigError(err)).toMatch(/benchmark\.runs/);
    }
  });
});
