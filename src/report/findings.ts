import type { PageAnatomy } from '../collect/page-anatomy.js';
import type { AttributionResult } from '../energy/attribution.js';

/**
 * Turn measurements into ranked, actionable findings.
 *
 * Each finding says what was observed, why it costs the browser work, and what
 * to change. Thresholds are heuristics — they flag things worth looking at,
 * not proven defects — so every finding carries its evidence and none of them
 * claims a joule figure for a specific element.
 */

export interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
  action: string;
  /** Work category this most affects, matching the attribution breakdown. */
  category: 'JavaScript' | 'Layout' | 'Graphics' | 'Network' | 'DOM' | 'GC / CC';
}

/** DOM size thresholds; Lighthouse uses ~800/1400 for warn/error. */
const DOM_NODES_WARN = 800;
const DOM_NODES_HIGH = 1400;
const DOM_DEPTH_WARN = 32;
const CSS_SELECTOR_WARN = 4000;
const CSS_SELECTOR_HIGH = 10000;

export function buildFindings(
  anatomy: PageAnatomy | undefined,
  attribution: AttributionResult | undefined,
): Finding[] {
  const findings: Finding[] = [];
  if (!anatomy) return findings;

  // --- Structure -----------------------------------------------------------
  if (anatomy.domNodes >= DOM_NODES_WARN) {
    findings.push({
      id: 'dom-size',
      severity: anatomy.domNodes >= DOM_NODES_HIGH ? 'high' : 'medium',
      title: `Large DOM (${anatomy.domNodes.toLocaleString()} nodes)`,
      evidence:
        `${anatomy.domNodes.toLocaleString()} elements, maximum depth ${anatomy.domDepth}.` +
        (anatomy.heaviestSubtrees[0]
          ? ` Heaviest subtree: ${anatomy.heaviestSubtrees[0].selector} ` +
            `(${anatomy.heaviestSubtrees[0].nodes.toLocaleString()} nodes).`
          : ''),
      action:
        'Every node is re-examined on style recalculation and layout. Paginate long lists, ' +
        'virtualise tables, and remove wrapper elements that exist only for styling.',
      category: 'Layout',
    });
  }

  if (anatomy.domDepth >= DOM_DEPTH_WARN) {
    findings.push({
      id: 'dom-depth',
      severity: 'medium',
      title: `Deeply nested DOM (${anatomy.domDepth} levels)`,
      evidence: `Deepest element chain is ${anatomy.domDepth} levels below <body>.`,
      action:
        'Deep trees make style inheritance and layout more expensive. Flatten wrapper ' +
        'chains; in Drupal this usually means trimming nested theme wrappers.',
      category: 'Layout',
    });
  }

  // --- CSS -----------------------------------------------------------------
  if (anatomy.cssSelectors >= CSS_SELECTOR_WARN) {
    findings.push({
      id: 'css-selectors',
      severity: anatomy.cssSelectors >= CSS_SELECTOR_HIGH ? 'high' : 'medium',
      title: `Large stylesheet surface (${anatomy.cssSelectors.toLocaleString()} selectors)`,
      evidence:
        `${anatomy.cssRules.toLocaleString()} rules across ${anatomy.stylesheets} stylesheets, ` +
        `${anatomy.cssSelectors.toLocaleString()} selectors total.`,
      action:
        'The style system may match many of these against every element. Split CSS per ' +
        'route so pages load only what they use, and drop rules for components not present.',
      category: 'Layout',
    });
  }

  if (anatomy.expensiveSelectors.length > 0) {
    const sample = anatomy.expensiveSelectors
      .slice(0, 3)
      .map((s) => `${s.selector} (${s.reason})`)
      .join('; ');
    findings.push({
      id: 'css-expensive-selectors',
      severity: 'low',
      title: `${anatomy.expensiveSelectors.length} selectors with high match cost`,
      evidence: sample,
      action:
        'Universal selectors, long descendant chains and :has()/:not() are matched right-to-left ' +
        'against many elements. Prefer a single class on the target element.',
      category: 'Layout',
    });
  }

  // --- Images --------------------------------------------------------------
  if (anatomy.oversizedImages.length > 0) {
    const worst = anatomy.oversizedImages[0]!;
    findings.push({
      id: 'oversized-images',
      severity: worst.ratio >= 10 ? 'high' : 'medium',
      title: `${anatomy.oversizedImages.length} image(s) far larger than displayed`,
      evidence:
        `Worst: ${worst.src.split('/').pop()} is ${Math.round(worst.ratio)}x more pixels than ` +
        'its displayed size.',
      action:
        'Decoding happens at natural size regardless of CSS scaling, so this is wasted CPU and ' +
        'memory as well as bytes. Serve responsive variants sized to the layout.',
      category: 'Graphics',
    });
  }

  if (anatomy.imagesWithoutDimensions > 0 && anatomy.images > 0) {
    findings.push({
      id: 'images-without-dimensions',
      severity: 'low',
      title: `${anatomy.imagesWithoutDimensions} of ${anatomy.images} images lack width/height`,
      evidence: 'Images without intrinsic dimensions force a reflow when each one arrives.',
      action:
        'Set width and height (or aspect-ratio) so layout is computed once rather than ' +
        'recalculated per image.',
      category: 'Layout',
    });
  }

  // --- Scripts and animation ----------------------------------------------
  if (anatomy.scripts >= 20) {
    findings.push({
      id: 'script-count',
      severity: anatomy.scripts >= 40 ? 'high' : 'medium',
      title: `${anatomy.scripts} script elements`,
      evidence: `${anatomy.scripts} scripts (${anatomy.inlineScripts} inline).`,
      action:
        'Each script is parsed, compiled and executed. In Drupal, check whether libraries are ' +
        'attached globally that only some pages need.',
      category: 'JavaScript',
    });
  }

  if (anatomy.animatedElements >= 10) {
    findings.push({
      id: 'animations',
      severity: 'medium',
      title: `${anatomy.animatedElements} elements with animations or transitions`,
      evidence: `${anatomy.animatedElements} elements have a non-zero animation or transition.`,
      action:
        'Running animations keep the refresh driver and compositor awake, drawing power even ' +
        'when nothing is interacting. Prefer transform/opacity, and honour ' +
        'prefers-reduced-motion.',
      category: 'Graphics',
    });
  }

  if (anatomy.iframes >= 3) {
    findings.push({
      id: 'iframes',
      severity: 'medium',
      title: `${anatomy.iframes} iframes`,
      evidence: `${anatomy.iframes} iframes on the page.`,
      action:
        'Each iframe is a separate document with its own style, layout and script work. Load ' +
        'them lazily, or only on interaction.',
      category: 'DOM',
    });
  }

  // --- Attribution-driven --------------------------------------------------
  if (attribution && attribution.totalCpuMs > 0) {
    const share = (name: string): number =>
      attribution.categories.find((c) => c.category === name)?.share ?? 0;

    if (share('JavaScript') >= 0.5) {
      findings.push({
        id: 'js-dominates',
        severity: 'high',
        title: `JavaScript is ${Math.round(share('JavaScript') * 100)}% of measured CPU work`,
        evidence: `${attribution.categories[0]?.cpuMs.toFixed(0)} ms of CPU in JavaScript.`,
        action:
          'Script execution dominates this workload. Defer non-critical scripts, remove unused ' +
          'libraries, and look for work running on every page that only some pages need.',
        category: 'JavaScript',
      });
    }
    if (share('Layout') >= 0.25) {
      findings.push({
        id: 'layout-dominates',
        severity: 'high',
        title: `Layout and style are ${Math.round(share('Layout') * 100)}% of measured CPU work`,
        evidence: 'Style recalculation and reflow account for a large share of CPU time.',
        action:
          'Reduce DOM size and selector count, and avoid reading layout properties immediately ' +
          'after writing to the DOM, which forces synchronous reflow.',
        category: 'Layout',
      });
    }
    if (share('GC / CC') >= 0.15) {
      findings.push({
        id: 'gc-pressure',
        severity: 'medium',
        title: `Garbage collection is ${Math.round(share('GC / CC') * 100)}% of measured CPU work`,
        evidence: 'A large share of CPU time is spent collecting garbage.',
        action:
          'High allocation churn. Look for per-frame object creation, large arrays rebuilt on ' +
          'each update, and listeners that are never removed.',
        category: 'GC / CC',
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
