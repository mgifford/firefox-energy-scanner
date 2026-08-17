import { describe, it, expect } from 'vitest';
import { summarizeRegions, type RawRegion } from '../src/drupal/twig-debug.js';

const region = (template: string, start: number, end: number, hook?: string): RawRegion => ({
  template,
  start,
  end,
  ...(hook ? { hook } : {}),
});

describe('summarizeRegions', () => {
  it('reports a single template', () => {
    const r = summarizeRegions([region('themes/x/node.html.twig', 0, 5, 'node')]);
    expect(r.enabled).toBe(true);
    expect(r.templates).toHaveLength(1);
    expect(r.templates[0]?.name).toBe('node.html.twig');
    expect(r.templates[0]?.hook).toBe('node');
    expect(r.templates[0]?.nodesInclusive).toBe(5);
    expect(r.templates[0]?.nodesExclusive).toBe(5);
  });

  /**
   * The point of the exclusive count: a wrapping region should not be credited
   * with markup its nested templates produced.
   */
  it('excludes nested template output from the parent', () => {
    const r = summarizeRegions([
      region('layout/region.html.twig', 0, 10, 'region'),
      region('content/node.html.twig', 1, 9, 'node'),
    ]);
    const parent = r.templates.find((t) => t.name === 'region.html.twig')!;
    const child = r.templates.find((t) => t.name === 'node.html.twig')!;
    expect(parent.nodesInclusive).toBe(10);
    expect(parent.nodesExclusive).toBe(2); // 10 - 8 nested
    expect(child.nodesExclusive).toBe(8);
  });

  it('aggregates repeated renders of the same template', () => {
    const r = summarizeRegions([
      region('content/node.html.twig', 0, 4),
      region('content/node.html.twig', 4, 8),
    ]);
    expect(r.templates).toHaveLength(1);
    expect(r.templates[0]?.occurrences).toBe(2);
    expect(r.templates[0]?.nodesExclusive).toBe(8);
  });

  it('sorts by owned markup, heaviest first', () => {
    const r = summarizeRegions([
      region('a/small.html.twig', 0, 2),
      region('a/large.html.twig', 10, 40),
    ]);
    expect(r.templates[0]?.name).toBe('large.html.twig');
  });

  it('counts attributed nodes without double counting overlaps', () => {
    const r = summarizeRegions([
      region('layout/region.html.twig', 0, 10),
      region('content/node.html.twig', 2, 6),
    ]);
    expect(r.attributedNodes).toBe(10);
  });

  it('always carries the benchmarking caveat', () => {
    const r = summarizeRegions([region('a/x.html.twig', 0, 1)]);
    expect(r.note).toMatch(/must not be used as benchmark numbers/i);
  });

  it('handles an empty region list', () => {
    const r = summarizeRegions([]);
    expect(r.templates).toEqual([]);
    expect(r.attributedNodes).toBe(0);
  });

  it('keeps identical sibling regions separate from nesting', () => {
    // Two adjacent regions with the same bounds must not be treated as nested
    // inside each other, which would zero their exclusive counts.
    const r = summarizeRegions([
      region('a/x.html.twig', 0, 4),
      region('a/x.html.twig', 0, 4),
    ]);
    expect(r.templates[0]?.occurrences).toBe(2);
    expect(r.templates[0]?.nodesExclusive).toBe(8);
  });
});
