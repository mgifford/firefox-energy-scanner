/**
 * Map rendered DOM back to the Twig templates that produced it.
 *
 * ## Why this is needed
 *
 * By the time Firefox sees a page, Twig has rendered to HTML and the template
 * boundary is gone. The browser has no concept of "this markup came from
 * node.html.twig", so heaviest-subtree output can only name CSS selectors.
 *
 * Drupal's Twig debug mode closes that gap by emitting HTML comments around
 * every template's output. Those comments are real DOM nodes, so they can be
 * read from inside the page and matched against the elements between them.
 *
 * ## The format
 *
 * Debug output wraps each template's markup:
 *
 *   <!-- THEME DEBUG -->
 *   <!-- THEME HOOK: 'node' -->
 *   <!-- FILE NAME SUGGESTIONS:
 *      * node--article--teaser.html.twig
 *      x node.html.twig
 *   -->
 *   <!-- BEGIN OUTPUT from 'core/themes/olivero/templates/content/node.html.twig' -->
 *   ...markup...
 *   <!-- END OUTPUT from 'core/themes/olivero/templates/content/node.html.twig' -->
 *
 * Newer Drupal emits `CALL: theme('node')` in place of, or alongside,
 * `THEME HOOK:`, so both are accepted.
 *
 * ## Caveats, which the caller must surface
 *
 * - Twig debug **changes performance**. It must never be enabled while
 *   benchmarking, only while identifying which templates own which markup.
 * - It is a development-only setting and can break some output (notably Views).
 * - Templates nest, so a node's markup is also inside a region's markup. Counts
 *   are therefore reported both inclusively and exclusively.
 */

export interface TemplateRegion {
  /** Template path, e.g. core/themes/olivero/templates/content/node.html.twig. */
  template: string;
  /** Short file name, e.g. node.html.twig. */
  name: string;
  /** Theme hook, when the comment provided one. */
  hook?: string;
  /** Elements inside this template, including nested templates. */
  nodesInclusive: number;
  /** Elements owned directly, excluding nested template output. */
  nodesExclusive: number;
  /** How many times this template was rendered on the page. */
  occurrences: number;
  /**
   * DevTools node paths of the first element each rendering produced (at most
   * five), so components recorded in the same page can be matched to it.
   */
  rootPaths?: string[];
}

export interface TwigDebugReport {
  enabled: boolean;
  templates: TemplateRegion[];
  /** Total elements attributed to any template. */
  attributedNodes: number;
  note: string;
}

const DISABLED_NOTE =
  'Twig debug is not enabled on this target, so markup cannot be traced back to ' +
  'templates. Enable twig.config.debug in a DEVELOPMENT environment to get template ' +
  'attribution — never in production, and never while benchmarking, because debug ' +
  'mode changes performance.';

/**
 * Read template regions from the live DOM.
 *
 * Returns `enabled: false` rather than throwing when the target has debug off,
 * which is the normal case for any production or default site.
 */
export async function collectTwigTemplates(page: {
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<TwigDebugReport> {
  try {
    const raw = await page.evaluate(() => {
      // Walk comments in document order, tracking BEGIN/END nesting.
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
      const begin = /BEGIN OUTPUT from '([^']+)'/;
      const end = /END OUTPUT from '([^']+)'/;
      const hookRe = /THEME HOOK: '([^']+)'|CALL: theme\('([^']+)'\)/;

      interface Open {
        template: string;
        hook?: string;
        startIndex: number;
      }

      const opened: Open[] = [];
      const closed: { template: string; hook?: string; start: number; end: number }[] = [];
      let pendingHook: string | undefined;

      // Number every element so ranges can be counted without holding nodes.
      const elements = Array.from(document.querySelectorAll('*'));
      const indexOf = new Map<Element, number>();
      elements.forEach((el, i) => indexOf.set(el, i));

      /** Index of the next element that appears after this comment. */
      const nextElementIndex = (comment: Comment): number => {
        let node: Node | null = comment;
        while (node) {
          let sib: Node | null = node.nextSibling;
          while (sib) {
            if (sib.nodeType === 1) {
              const idx = indexOf.get(sib as Element);
              if (idx !== undefined) return idx;
            }
            sib = sib.nextSibling;
          }
          node = node.parentNode;
        }
        return elements.length;
      };

      let comment = walker.nextNode() as Comment | null;
      while (comment) {
        const value = comment.nodeValue ?? '';

        const hookMatch = hookRe.exec(value);
        if (hookMatch) pendingHook = hookMatch[1] ?? hookMatch[2];

        const beginMatch = begin.exec(value);
        if (beginMatch) {
          opened.push({
            template: beginMatch[1]!,
            ...(pendingHook ? { hook: pendingHook } : {}),
            startIndex: nextElementIndex(comment),
          });
          pendingHook = undefined;
        }

        const endMatch = end.exec(value);
        if (endMatch) {
          // Close the most recent matching open region.
          for (let i = opened.length - 1; i >= 0; i--) {
            if (opened[i]!.template === endMatch[1]) {
              const o = opened.splice(i, 1)[0]!;
              closed.push({
                template: o.template,
                ...(o.hook ? { hook: o.hook } : {}),
                start: o.startIndex,
                end: nextElementIndex(comment),
              });
              break;
            }
          }
        }

        comment = walker.nextNode() as Comment | null;
      }

      // Lighthouse's node path format, as page-anatomy records for components.
      const nodePath = (node: Node): string => {
        const path: string[] = [];
        let cur: Node | null = node;
        while (cur && cur.parentNode) {
          let i = 0;
          let prev: Node | null = cur;
          while ((prev = prev.previousSibling)) {
            if (prev.nodeType === 3 && (prev.nodeValue ?? '').trim().length === 0) continue;
            i++;
          }
          path.push(`${i},${cur.nodeName}`);
          cur = cur.parentNode;
        }
        return path.reverse().join(',');
      };
      const withRoots = closed.map((r) => (r.start < r.end && elements[r.start] ? { ...r, rootPath: nodePath(elements[r.start]!) } : r));
      return { regions: withRoots, totalElements: elements.length };
    });

    if (raw.regions.length === 0) {
      return { enabled: false, templates: [], attributedNodes: 0, note: DISABLED_NOTE };
    }

    return summarizeRegions(raw.regions);
  } catch {
    return { enabled: false, templates: [], attributedNodes: 0, note: DISABLED_NOTE };
  }
}

export interface RawRegion {
  template: string;
  hook?: string;
  start: number;
  end: number;
  rootPath?: string;
}

/**
 * Aggregate raw regions into per-template totals.
 *
 * Exported for testing without a browser.
 */
export function summarizeRegions(regions: RawRegion[]): TwigDebugReport {
  const byTemplate = new Map<string, TemplateRegion>();
  const attributed = new Set<number>();

  for (const r of regions) {
    const inclusive = Math.max(0, r.end - r.start);

    // Exclusive count removes elements owned by templates nested inside this
    // one, so a region's own markup is not double-counted up the tree.
    let nested = 0;
    for (const other of regions) {
      if (other === r) continue;
      if (other.start >= r.start && other.end <= r.end && !(other.start === r.start && other.end === r.end)) {
        nested += Math.max(0, other.end - other.start);
      }
    }
    const exclusive = Math.max(0, inclusive - nested);

    for (let i = r.start; i < r.end; i++) attributed.add(i);

    const name = r.template.split('/').pop() ?? r.template;
    const existing = byTemplate.get(r.template);
    if (existing) {
      existing.nodesInclusive += inclusive;
      existing.nodesExclusive += exclusive;
      existing.occurrences += 1;
      if (!existing.hook && r.hook) existing.hook = r.hook;
      if (r.rootPath && (existing.rootPaths ?? []).length < 5) existing.rootPaths = [...(existing.rootPaths ?? []), r.rootPath];
    } else {
      byTemplate.set(r.template, {
        template: r.template,
        name,
        ...(r.hook ? { hook: r.hook } : {}),
        nodesInclusive: inclusive,
        nodesExclusive: exclusive,
        occurrences: 1,
        ...(r.rootPath ? { rootPaths: [r.rootPath] } : {}),
      });
    }
  }

  const templates = [...byTemplate.values()].sort(
    (a, b) => b.nodesExclusive - a.nodesExclusive,
  );

  return {
    enabled: true,
    templates,
    attributedNodes: attributed.size,
    note:
      'Template attribution comes from Twig debug comments. Debug mode changes ' +
      'performance, so these figures identify WHICH templates own the markup — they ' +
      'must not be used as benchmark numbers.',
  };
}

/**
 * The Twig template whose output starts at each component occurrence, by
 * node path: Drupal's node, block, paragraph and view templates each wrap
 * their output in one element, the one the component signature reads.
 * Development only: Twig debug changes the markup and the server's work.
 */
export function templatesForInstances(
  instances: { signature: string; nodePath: string }[],
  report: TwigDebugReport,
): { signature: string; nodePath: string; template: string; name: string }[] {
  const byPath = new Map<string, TemplateRegion>();
  // When an outer template adds no wrapper, its output and an inner one's
  // start at the same element. The innermost (smaller output) is the one that
  // wrote that element.
  const size = (t: TemplateRegion) => t.nodesInclusive / Math.max(1, t.occurrences);
  for (const t of report.templates) {
    for (const p of t.rootPaths ?? []) {
      const prev = byPath.get(p);
      if (!prev || size(t) < size(prev)) byPath.set(p, t);
    }
  }
  return instances.flatMap((i) => {
    const t = byPath.get(i.nodePath);
    return t ? [{ signature: i.signature, nodePath: i.nodePath, template: t.template, name: t.name }] : [];
  });
}
