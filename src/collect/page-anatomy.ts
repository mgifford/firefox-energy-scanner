import type { Page } from 'playwright';

/**
 * Page composition metrics, collected from inside the page.
 *
 * ## Why this exists, and what it can and cannot say
 *
 * Firefox's power counter is whole-process, and the Gecko profile carries no
 * DOM node references — `Styles` markers carry an `innerWindowID` and a stack,
 * not an element. Mozilla's own requests for element-level attribution are
 * still open (bug 789712 "Show what is triggering a reflow", bug 713031 "Add
 * CSS selector profiler"). So **no tool here can say "this div cost 3 mJ"**.
 *
 * What *is* available is the page's structure: how many nodes, how deep, how
 * many selectors the style system must match, how many scripts and images.
 * These are the inputs to the work the browser does, so correlating them with
 * measured energy across pages points at what to change — without pretending
 * to attribute joules to an element.
 *
 * Largest Contentful Paint is the one genuine element-level signal Firefox
 * exposes, and it is captured for that reason.
 */

export interface PageAnatomy {
  domNodes: number;
  domDepth: number;
  /** Elements whose subtree is unusually large; candidates for splitting. */
  heaviestSubtrees: { selector: string; nodes: number }[];
  stylesheets: number;
  cssRules: number;
  /** Total selectors the style system may need to match. */
  cssSelectors: number;
  /** Selectors with high match cost: descendant chains, universal, :not(). */
  expensiveSelectors: { selector: string; reason: string }[];
  scripts: number;
  inlineScripts: number;
  scriptBytes: number;
  images: number;
  /** Images served much larger than their displayed size. */
  oversizedImages: { src: string; naturalPx: number; displayedPx: number; ratio: number }[];
  imagesWithoutDimensions: number;
  iframes: number;
  webfonts: number;
  animatedElements: number;
  /** LCP element, the one element-level signal Firefox exposes. */
  lcpElement?: { selector: string; renderTimeMs: number; sizePx: number };
}

/** Read structural metrics after the page has settled. */
export async function collectPageAnatomy(page: Page): Promise<PageAnatomy | undefined> {
  try {
    return await page.evaluate(() => {
      const shortSelector = (el: Element): string => {
        const id = el.id ? `#${el.id}` : '';
        if (id) return `${el.tagName.toLowerCase()}${id}`;
        const cls = (el.className && typeof el.className === 'string')
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        return `${el.tagName.toLowerCase()}${cls}`.slice(0, 60);
      };

      const all = document.querySelectorAll('*');
      const domNodes = all.length;

      let domDepth = 0;
      const depthOf = (node: Element, level: number): number => {
        let max = level;
        // Array.from rather than for-of: HTMLCollection is not iterable under
        // every DOM lib configuration, and a bare for-of fails to compile.
        for (const child of Array.from(node.children)) {
          max = Math.max(max, depthOf(child, level + 1));
        }
        return max;
      };
      if (document.body) domDepth = depthOf(document.body, 0);

      // Subtree sizes locate the structurally heavy parts of the page.
      const subtrees: { selector: string; nodes: number }[] = [];
      for (const el of Array.from(all)) {
        const count = el.querySelectorAll('*').length;
        if (count > Math.max(50, domNodes * 0.1)) {
          subtrees.push({ selector: shortSelector(el), nodes: count });
        }
      }
      subtrees.sort((a, b) => b.nodes - a.nodes);

      let cssRules = 0;
      let cssSelectors = 0;
      const expensiveSelectors: { selector: string; reason: string }[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            cssRules++;
            const selectorText = (rule as CSSStyleRule).selectorText;
            if (!selectorText) continue;
            for (const sel of selectorText.split(',')) {
              cssSelectors++;
              const s = sel.trim();
              // Heuristics for selectors the style system matches slowly.
              if (expensiveSelectors.length >= 20) continue;
              if (/^\*|\s\*/.test(s)) {
                expensiveSelectors.push({ selector: s.slice(0, 80), reason: 'universal selector' });
              } else if ((s.match(/\s+/g) ?? []).length >= 3) {
                expensiveSelectors.push({ selector: s.slice(0, 80), reason: 'deep descendant chain' });
              } else if (/:not\(|:has\(/.test(s)) {
                expensiveSelectors.push({ selector: s.slice(0, 80), reason: 'costly pseudo-class' });
              }
            }
          }
        } catch {
          // Cross-origin stylesheets cannot be inspected.
        }
      }

      const scriptEls = Array.from(document.scripts);
      let inlineScripts = 0;
      let scriptBytes = 0;
      for (const s of scriptEls) {
        if (!s.src) {
          inlineScripts++;
          scriptBytes += s.textContent?.length ?? 0;
        }
      }

      const imgs = Array.from(document.images);
      const oversizedImages: PageAnatomyOversized[] = [];
      let imagesWithoutDimensions = 0;
      for (const img of imgs) {
        const displayed = img.clientWidth * img.clientHeight;
        const natural = img.naturalWidth * img.naturalHeight;
        if (displayed > 0 && natural > displayed * 4) {
          oversizedImages.push({
            src: img.currentSrc || img.src,
            naturalPx: natural,
            displayedPx: displayed,
            ratio: natural / displayed,
          });
        }
        // Missing intrinsic size forces reflow when the image arrives.
        if (!img.getAttribute('width') || !img.getAttribute('height')) imagesWithoutDimensions++;
      }
      oversizedImages.sort((a, b) => b.ratio - a.ratio);

      // Elements with running CSS animations or transitions keep the
      // compositor and refresh driver awake.
      let animatedElements = 0;
      for (const el of Array.from(all)) {
        const cs = getComputedStyle(el);
        if ((cs.animationName && cs.animationName !== 'none') ||
            (cs.transitionDuration && cs.transitionDuration !== '0s')) {
          animatedElements++;
        }
      }

      const webfonts = (document as unknown as { fonts?: { size?: number } }).fonts?.size ?? 0;

      return {
        domNodes,
        domDepth,
        heaviestSubtrees: subtrees.slice(0, 5),
        stylesheets: document.styleSheets.length,
        cssRules,
        cssSelectors,
        expensiveSelectors: expensiveSelectors.slice(0, 10),
        scripts: scriptEls.length,
        inlineScripts,
        scriptBytes,
        images: imgs.length,
        oversizedImages: oversizedImages.slice(0, 5),
        imagesWithoutDimensions,
        iframes: document.querySelectorAll('iframe').length,
        webfonts,
        animatedElements,
      } as PageAnatomy;
    });
  } catch {
    return undefined;
  }
}

interface PageAnatomyOversized {
  src: string;
  naturalPx: number;
  displayedPx: number;
  ratio: number;
}

/**
 * Capture the Largest Contentful Paint element.
 *
 * This must be installed *before* navigation, because LCP entries are emitted
 * during load. It is the only element-level attribution Firefox provides.
 */
export async function installLcpObserver(page: Page): Promise<void> {
  await page
    .addInitScript(() => {
      const w = window as unknown as { __lcp?: { selector: string; renderTimeMs: number; sizePx: number } };
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1] as
            | (PerformanceEntry & { element?: Element; size?: number; renderTime?: number; loadTime?: number })
            | undefined;
          if (!last) return;
          const el = last.element;
          const selector = el
            ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`
            : '(unknown)';
          w.__lcp = {
            selector,
            renderTimeMs: last.renderTime || last.loadTime || last.startTime,
            sizePx: last.size ?? 0,
          };
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {
        // LCP unsupported; the field is simply omitted.
      }
    })
    .catch(() => {});
}

export async function readLcp(page: Page): Promise<PageAnatomy['lcpElement']> {
  try {
    return await page.evaluate(
      () => (window as unknown as { __lcp?: PageAnatomy['lcpElement'] }).__lcp,
    );
  } catch {
    return undefined;
  }
}
