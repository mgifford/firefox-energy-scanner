import { describe, it, expect } from 'vitest';
import { buildFindings } from '../src/report/findings.js';
import type { PageAnatomy } from '../src/collect/page-anatomy.js';

const anatomy = (over: Partial<PageAnatomy> = {}): PageAnatomy => ({
  domNodes: 100, domDepth: 10, heaviestSubtrees: [],
  stylesheets: 1, cssRules: 50, cssSelectors: 60, expensiveSelectors: [],
  scripts: 2, inlineScripts: 0, scriptBytes: 0,
  images: 0, oversizedImages: [], imagesWithoutDimensions: 0,
  iframes: 0, webfonts: 0, animatedElements: 0,
  ...over,
});

describe('buildFindings', () => {
  it('returns nothing for a lean page', () => {
    expect(buildFindings(anatomy(), undefined)).toEqual([]);
  });

  it('flags a large DOM, escalating with size', () => {
    expect(buildFindings(anatomy({ domNodes: 900 }), undefined)[0]?.severity).toBe('medium');
    expect(buildFindings(anatomy({ domNodes: 2000 }), undefined)[0]?.severity).toBe('high');
  });

  it('flags oversized images and says why decode cost matters', () => {
    const f = buildFindings(
      anatomy({ oversizedImages: [{ src: 'a.png', naturalPx: 1000, displayedPx: 50, ratio: 20 }] }),
      undefined,
    );
    const img = f.find((x) => x.id === 'oversized-images')!;
    expect(img.severity).toBe('high');
    expect(img.action).toMatch(/decod/i);
  });

  it('flags animations as a Graphics cost', () => {
    const f = buildFindings(anatomy({ animatedElements: 25 }), undefined);
    expect(f.find((x) => x.id === 'animations')?.category).toBe('Graphics');
  });

  it('uses attribution shares to flag a dominant category', () => {
    const attribution = {
      categories: [
        { category: 'JavaScript', cpuMs: 900, share: 0.9 },
        { category: 'Layout', cpuMs: 100, share: 0.1 },
      ],
      totalCpuMs: 1000,
      basis: 'cpu-time' as const,
      method: 'cpu-time-apportioned' as const,
      assumption: 'x',
      sampleCount: 100,
    };
    const f = buildFindings(anatomy(), attribution);
    expect(f.find((x) => x.id === 'js-dominates')?.severity).toBe('high');
  });

  it('sorts high severity first', () => {
    const f = buildFindings(
      anatomy({ domNodes: 2000, animatedElements: 25, expensiveSelectors: [{ selector: '*', reason: 'universal selector' }] }),
      undefined,
    );
    expect(f[0]?.severity).toBe('high');
    expect(f[f.length - 1]?.severity).toBe('low');
  });

  it('returns nothing without anatomy', () => {
    expect(buildFindings(undefined, undefined)).toEqual([]);
  });
});
