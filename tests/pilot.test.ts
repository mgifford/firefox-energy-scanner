import { describe, it, expect } from 'vitest';
import { buildPilotPlan, DEFAULT_PILOT_PAGES, MAX_PILOT_PAGES, pilotName, validatePilotUrl } from '../src/analysis/pilot.js';

describe('the public-site pilot plan', () => {
  it('accepts a public HTTPS page and strips the fragment', () => {
    expect(validatePilotUrl('https://www.cms.gov/medicare-coverage-database/search.aspx#top')).toBe(
      'https://www.cms.gov/medicare-coverage-database/search.aspx',
    );
  });

  it('refuses non-HTTPS, credentials and private hosts', () => {
    for (const url of [
      'http://www.cms.gov/',
      'https://user:pass@www.cms.gov/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://10.0.0.2/',
      'https://192.168.1.2/',
      'https://172.20.0.1/',
      'https://[::1]/',
      'https://something.local/',
      'https://example.test/',
    ]) {
      expect(() => validatePilotUrl(url), url).toThrow();
    }
  });

  it('builds a capped structural crawl, never an energy run', () => {
    const plan = buildPilotPlan({ url: 'https://www.cms.gov/medicare-coverage-database/search.aspx', maxPages: 12, outDir: '/tmp/pilot' });
    expect(plan.schema).toBe('public-site-pilot/1');
    expect(plan.maxPages).toBe(12);
    expect(plan.structural).toBe(true);
    expect(plan.energy).toBe('not-measured');
    expect(plan.environment.WEB_ENERGY_TEST_ENGINE).toBe('chromium');
    expect(plan.crawl).toContain('--no-energy');
    expect(plan.crawl).toContain('--max-pages');
    expect(plan.crawl).toContain('--max-depth');
    expect(plan.crawl).toContain('--lighthouse');
    expect(plan.crawl).toContain('--trace');
    expect(plan.crawl).not.toContain('--public-only');
    expect(plan.crawl).not.toContain('experiment');
    expect(plan.resultPattern).toBe('/tmp/pilot/crawl-*.json');
    expect(plan.limitations.join(' ')).toMatch(/not a Firefox energy measurement/);
  });

  it('defaults to 20 pages and bounds the page cap', () => {
    expect(buildPilotPlan({ url: 'https://www.example.org/' }).maxPages).toBe(DEFAULT_PILOT_PAGES);
    expect(() => buildPilotPlan({ url: 'https://www.example.org/', maxPages: 0 })).toThrow();
    expect(() => buildPilotPlan({ url: 'https://www.example.org/', maxPages: MAX_PILOT_PAGES + 1 })).toThrow();
    expect(() => buildPilotPlan({ url: 'https://www.example.org/', maxPages: 1.5 })).toThrow();
  });

  it('makes a path-safe name', () => {
    expect(pilotName('www.cms.gov')).toBe('www-cms-gov');
    expect(pilotName('  Site / One  ')).toBe('site-one');
    expect(pilotName('***')).toBe('site');
  });
});
