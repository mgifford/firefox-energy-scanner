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
  /** What the page is built from, for grouping pages into families. */
  structure?: PageStructure;
}

/**
 * A recognisable building block, and how it was recognised. Methods, most
 * trustworthy first: an explicit annotation the site put there, a framework
 * boundary, a Drupal class convention, a landmark, then a class-name guess.
 */
export interface ComponentSignature {
  signature: string;
  method: 'annotation' | 'framework' | 'drupal' | 'landmark' | 'class-heuristic';
  /** How many times it appears on the page. */
  count: number;
  /** Elements inside all its occurrences, the occurrence included. */
  nodes: number;
  /**
   * Elements it owns: those whose nearest component is one of its
   * occurrences, so nested components' elements are not counted twice. 0 for
   * a landmark that is the role of another component's element. Absent in
   * results made before it was recorded.
   */
  ownNodes?: number;
}

/**
 * What a component, or the page outside every component, owns: the elements,
 * media and animations whose nearest component it is. Owned counts never
 * overlap, so they can be added up; inclusive ones cannot.
 */
export interface OwnCounts {
  nodes: number;
  images: number;
  eagerOffscreenImages: number;
  videos: number;
  autoplayVideos: number;
  iframes: number;
  canvases: number;
  animations: number;
  infiniteAnimations: number;
}

/**
 * One occurrence of a component on a page: where it is and what it holds.
 * Structure, not cost: nothing here says how much energy the element uses.
 */
export interface ComponentInstance {
  signature: string;
  method: ComponentSignature['method'];
  /** A CSS selector that matched only this element when it was recorded. */
  selector: string;
  /**
   * DevTools node path ("1,HTML,1,BODY,0,DIV"), as Lighthouse reports it, so
   * Lighthouse's element findings can be matched to the component they fall in.
   */
  nodePath: string;
  /** Signatures of the components it sits inside, outermost first. */
  ancestry: string[];
  /** ARIA role, explicit or implied by the element. */
  role?: string;
  /** Accessible name, or the first heading inside it; at most 60 characters. */
  name?: string;
  /** Elements in it, itself included. */
  nodes: number;
  /** Deepest nesting below it. */
  depth: number;
  /** Position and size in CSS pixels, relative to the top of the document. */
  rect: { x: number; y: number; width: number; height: number };
  /** Starts below the first screenful. */
  belowFold: boolean;
  media?: {
    images: number;
    /** Images below the first screenful without loading="lazy". */
    eagerOffscreenImages: number;
    videos: number;
    /** Videos set to autoplay or playing when recorded. */
    autoplayVideos: number;
    iframes: number;
    canvases: number;
  };
  /** Images, video, iframes and external scripts inside it: at most 6, plus how many there were. */
  resources?: { url: string; kind: 'image' | 'video' | 'iframe' | 'script' }[];
  resourceCount?: number;
  inlineScripts?: number;
  /** Web Animations API: animations whose target is inside it. */
  animations?: { running: number; infinite: number; names: string[] };
  /** An ARIA live region, or one inside it. */
  liveRegion?: boolean;
  /** The element's tag name, lower case. */
  tag?: string;
  /**
   * What it owns, excluding everything inside nested components (recorded
   * or not). Absent in results made before it was recorded.
   */
  own?: OwnCounts;
  /** Images, video, iframes and external scripts it owns directly: at most 6. */
  ownResources?: { url: string; kind: 'image' | 'video' | 'iframe' | 'script' }[];
}

/**
 * The page's structure as a fingerprint: landmarks, components, framework
 * roots and Drupal hints. Read from the DOM after the measured window, so it
 * adds nothing to the energy figure. It says what a page is made of, not what
 * any part of it costs.
 */
export interface PageStructure {
  /** ARIA landmark roles in document order (header outside sectioning content is banner, and so on). */
  landmarks: string[];
  /** Largest first, by elements; at most 40. */
  components: ComponentSignature[];
  /** Framework roots found: react, next, vue, angular, svelte, web-components, drupal. */
  frameworks: string[];
  /**
   * The largest component occurrences, plus any holding media or animations:
   * where on the page each one is and what it contains. At most 24. Absent
   * in results made before it existed.
   */
  instances?: ComponentInstance[];
  /** What belongs to no component: page-level markup and media in <body>. */
  unowned?: OwnCounts;
  drupal?: {
    /** page-node-type-*, or the path-* class, with numbers replaced by :id. */
    pageTemplate?: string;
    /** Body classes that name templates or routes, numbers replaced by :id. */
    bodyClasses: string[];
    theme?: string;
    /** Libraries from drupalSettings, when Drupal sends them uncompressed. */
    libraries?: string[];
  };
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

      // --- Structure: what the page is built from --------------------------
      const LANDMARK_ROLES = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'];
      const named = (el: Element) => !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
      const landmarkOf = (el: Element): string | undefined => {
        const role = el.getAttribute('role');
        if (role && LANDMARK_ROLES.includes(role)) return role;
        const tag = el.tagName.toLowerCase();
        if (tag === 'main') return 'main';
        if (tag === 'nav') return 'navigation';
        if (tag === 'aside') return 'complementary';
        if (tag === 'search') return 'search';
        // header and footer are landmarks only outside sectioning content.
        if (tag === 'header' || tag === 'footer') {
          if (el.parentElement?.closest('article, aside, main, nav, section')) return undefined;
          return tag === 'header' ? 'banner' : 'contentinfo';
        }
        if ((tag === 'form' || tag === 'section') && named(el)) return tag === 'form' ? 'form' : 'region';
        return undefined;
      };

      // Class names too generic to identify a component.
      const GENERIC = new Set([
        'container', 'container-fluid', 'wrapper', 'inner', 'outer', 'row', 'col', 'column', 'columns',
        'clearfix', 'content', 'contents', 'grid', 'flex', 'layout', 'section', 'main', 'page', 'site',
        'block', 'field', 'item', 'items', 'list', 'link', 'links', 'hidden', 'visually-hidden', 'sr-only',
        'active', 'open', 'show', 'collapse', 'collapsed', 'text', 'title', 'body', 'region', 'view',
        'node', 'paragraph', 'contextual-region', 'clearfix', 'd-flex', 'd-none', 'd-block',
      ]);
      const isUtility = (t: string) =>
        GENERIC.has(t) || /^(js|is|has|u|util|l|t|text|bg|m[trblxy]?|p[trblxy]?|w|h|d|col|row|gap|order|flex|grid|align|justify|float|fs|fw|lh|ws)-/.test(t) ||
        /\d/.test(t) || t.length < 3 || /__|--/.test(t) || /^(path|page|node|layout)-/.test(t);
      const idDigits = (s: string) => s.replace(/\d+/g, ':id');

      const sigs = new Map<string, { signature: string; method: string; count: number; nodes: number }>();
      // Every element that got a signature, for instances and their ancestry.
      // A landmark and a component on one element: the component names it.
      const elSig = new Map<Element, { signature: string; method: string; nodes: number }>();
      const add = (signature: string, method: string, el: Element) => {
        const entry = sigs.get(signature) ?? { signature, method, count: 0, nodes: 0 };
        const nodes = el.getElementsByTagName('*').length + 1;
        entry.count++;
        entry.nodes += nodes;
        sigs.set(signature, entry);
        if (!elSig.has(el) || elSig.get(el)!.method === 'landmark') elSig.set(el, { signature, method, nodes });
      };
      const landmarks: string[] = [];
      const frameworks = new Set<string>();
      for (const el of Array.from(all)) {
        // The root and body carry page-level classes (route, template), recorded below.
        if (el === document.documentElement || el === document.body) continue;
        const lm = landmarkOf(el);
        if (lm) {
          if (landmarks.length < 30) landmarks.push(lm);
          add(`landmark:${lm}`, 'landmark', el);
        }
        const tag = el.tagName.toLowerCase();
        const explicit = el.getAttribute('data-component-id') ?? el.getAttribute('data-component');
        if (explicit) {
          add(`component:${idDigits(explicit.slice(0, 60))}`, 'annotation', el);
          continue;
        }
        if (tag.includes('-')) {
          frameworks.add('web-components');
          add(`element:${tag}`, 'framework', el);
          continue;
        }
        if (el.id === '__next') { frameworks.add('next'); add('framework:next-root', 'framework', el); continue; }
        if (el.hasAttribute('data-reactroot')) { frameworks.add('react'); add('framework:react-root', 'framework', el); continue; }
        if (el.hasAttribute('ng-version')) { frameworks.add('angular'); add('framework:angular-root', 'framework', el); continue; }
        if (el.hasAttribute('data-v-app') || el.hasAttribute('data-server-rendered')) { frameworks.add('vue'); add('framework:vue-root', 'framework', el); continue; }
        const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
        if (classes.some((c) => c.startsWith('svelte-'))) frameworks.add('svelte');
        // Drupal class conventions name the template or plugin that rendered the markup.
        const has = (c: string) => classes.includes(c);
        const pick = (re: RegExp) => classes.map((c) => re.exec(c)?.[1]).find(Boolean);
        const node = pick(/^node--type-(.+)$/);
        if (node) { add(`drupal-node:${node}${pick(/^node--view-mode-(.+)$/) ? ':' + pick(/^node--view-mode-(.+)$/) : ''}`, 'drupal', el); continue; }
        const paragraph = pick(/^paragraph--type--(.+)$/);
        if (paragraph) { add(`drupal-paragraph:${paragraph}`, 'drupal', el); continue; }
        const view = pick(/^view-id-(.+)$/);
        if (view && has('view')) { add(`drupal-view:${view}`, 'drupal', el); continue; }
        const block = has('block') ? classes.find((c) => c.startsWith('block-') && c !== 'block-content') : undefined;
        if (block) { add(`drupal-block:${idDigits(block.slice(6))}`, 'drupal', el); continue; }
        const region = pick(/^region-(.+)$/) ?? pick(/^region--(.+)$/);
        if (region && has('region')) { add(`drupal-region:${region}`, 'drupal', el); continue; }
        // Fallback: a block-level class on an element with real content.
        if (el.getElementsByTagName('*').length >= 10) {
          const token = classes.find((c) => /^[a-z][a-z0-9-]*$/.test(c) && !isUtility(c));
          if (token) add(`class:${token}`, 'class-heuristic', el);
        }
      }

      // Drupal: body classes and drupalSettings name the route, template and libraries.
      let drupal: PageStructure['drupal'];
      const settingsEl = document.querySelector('script[data-drupal-selector="drupal-settings-json"]');
      const bodyClasses = Array.from(document.body?.classList ?? []);
      if (settingsEl || document.querySelector('[data-drupal-selector], [data-drupal-link-system-path]') || bodyClasses.some((c) => c.startsWith('path-'))) {
        frameworks.add('drupal');
        const routeClasses = bodyClasses
          .filter((c) => /^(path-|page-node-type-|page-|node--type-|layout-|user-logged-in)/.test(c))
          .map(idDigits)
          .filter((c, i, list) => list.indexOf(c) === i)
          .slice(0, 12);
        let theme: string | undefined;
        let libraries: string[] | undefined;
        try {
          const settings = JSON.parse(settingsEl?.textContent ?? 'null') as { ajaxPageState?: { theme?: string; libraries?: string } } | null;
          theme = settings?.ajaxPageState?.theme;
          const libs = settings?.ajaxPageState?.libraries;
          // Drupal 10.1+ compresses this list; only a plain list is readable here.
          if (typeof libs === 'string' && libs.includes('/')) libraries = libs.split(',').slice(0, 80);
        } catch {
          /* not JSON */
        }
        drupal = {
          ...(routeClasses.find((c) => c.startsWith('page-node-type-')) ?? routeClasses.find((c) => c.startsWith('path-'))
            ? { pageTemplate: routeClasses.find((c) => c.startsWith('page-node-type-')) ?? routeClasses.find((c) => c.startsWith('path-')) }
            : {}),
          bodyClasses: routeClasses,
          ...(theme ? { theme } : {}),
          ...(libraries ? { libraries } : {}),
        };
      }
      // --- Instances: where the largest components are, and what they hold --
      // Lighthouse's getNodePath, so its element findings can be matched here.
      const nodePath = (node: Node): string => {
        const index = (n: Node): number | string => {
          if (n.nodeType === 11) return 'a';
          let i = 0;
          let prev: Node | null = n;
          while ((prev = prev.previousSibling)) {
            if (prev.nodeType === 3 && (prev.nodeValue ?? '').trim().length === 0) continue;
            i++;
          }
          return i;
        };
        const parentOf = (n: Node): Node | null => (n.nodeType === 11 ? (n as ShadowRoot).host : n.parentNode);
        const path: string[] = [];
        let cur: Node | null = node;
        while (cur && parentOf(cur)) {
          path.push(`${index(cur)},${cur.nodeName}`);
          cur = parentOf(cur);
        }
        return path.reverse().join(',');
      };
      const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
      const unique = (sel: string) => {
        try {
          return document.querySelectorAll(sel).length === 1;
        } catch {
          return false;
        }
      };
      const selectorOf = (el: Element): string => {
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && parts.length < 8) {
          if (cur.id && unique(`#${esc(cur.id)}`)) {
            parts.unshift(`#${esc(cur.id)}`);
            break;
          }
          let part = cur.tagName.toLowerCase();
          if (cur === document.body || cur === document.documentElement) {
            parts.unshift(part);
            break;
          }
          const cls = Array.from(cur.classList).find((c) => /^[a-zA-Z][\w-]*$/.test(c) && !isUtility(c));
          if (cls) part += `.${esc(cls)}`;
          const parent: Element | null = cur.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
            const sameSel = cls ? sameTag.filter((c) => c.classList.contains(cls)) : sameTag;
            if (sameSel.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
          }
          parts.unshift(part);
          if (unique(parts.join(' > '))) break;
          cur = parent;
        }
        return parts.join(' > ');
      };
      const IMPLICIT: Record<string, string> = {
        article: 'article', ul: 'list', ol: 'list', table: 'table', dialog: 'dialog', figure: 'figure',
        img: 'img', button: 'button', details: 'group', fieldset: 'group',
      };
      const roleOf = (el: Element): string | undefined =>
        el.getAttribute('role') ?? landmarkOf(el) ?? (el.tagName === 'A' && el.hasAttribute('href') ? 'link' : IMPLICIT[el.tagName.toLowerCase()]);
      const clip = (s: string | null | undefined) => {
        const t = (s ?? '').replace(/\s+/g, ' ').trim();
        return t ? (t.length > 60 ? `${t.slice(0, 59)}…` : t) : undefined;
      };
      const nameOf = (el: Element): string | undefined => {
        const label = clip(el.getAttribute('aria-label'));
        if (label) return label;
        const ids = el.getAttribute('aria-labelledby');
        if (ids) {
          const text = clip(ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
          if (text) return text;
        }
        // A heading names sectioning content only; the first heading in <main> is not its name.
        const sectioning = ['article', 'region', 'complementary', 'dialog', 'group'].includes(roleOf(el) ?? '') || el.tagName === 'SECTION';
        return (sectioning ? clip(el.querySelector('h1, h2, h3, h4')?.textContent) : undefined) ?? clip(el.getAttribute('title'));
      };
      const depthBelow = (el: Element): number => {
        let max = 0;
        for (const child of Array.from(el.children)) max = Math.max(max, 1 + depthBelow(child));
        return max;
      };

      let animations: Animation[] = [];
      try {
        animations = document.getAnimations();
      } catch {
        /* no Web Animations API */
      }
      const animationTarget = (a: Animation): Element | undefined => {
        const t = (a.effect as KeyframeEffect | null)?.target;
        return t instanceof Element ? t : undefined;
      };
      const animated = animations.map((a) => ({ a, target: animationTarget(a) })).filter((x) => x.target);
      const viewportHeight = window.innerHeight || 0;
      const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]';
      const hasActivity = (el: Element) =>
        !!el.querySelector('video, iframe, canvas') || animated.some((x) => el.contains(x.target!));

      // The largest first, at most three of any one signature (a list of 60
      // teasers is one component, counted in `components`); then up to six
      // smaller ones holding media or animations.
      const ranked = [...elSig].sort((a, b) => b[1].nodes - a[1].nodes);
      const perSignature = new Map<string, number>();
      const room = (sig: string) => (perSignature.get(sig) ?? 0) < 3;
      const chosen: typeof ranked = [];
      const rest: typeof ranked = [];
      for (const entry of ranked) {
        if (chosen.length < 18 && room(entry[1].signature)) {
          chosen.push(entry);
          perSignature.set(entry[1].signature, (perSignature.get(entry[1].signature) ?? 0) + 1);
        } else rest.push(entry);
      }
      for (const entry of rest) {
        if (chosen.length >= 24) break;
        if (room(entry[1].signature) && hasActivity(entry[0])) {
          chosen.push(entry);
          perSignature.set(entry[1].signature, (perSignature.get(entry[1].signature) ?? 0) + 1);
        }
      }
      // --- Own accounting: each element belongs to its nearest component,
      // itself included. Document order visits parents first, so one pass.
      const ownerOf = new Map<Element, Element | null>();
      for (const el of Array.from(all)) {
        const parent = el.parentElement;
        ownerOf.set(el, elSig.has(el) ? el : parent ? (ownerOf.get(parent) ?? null) : null);
      }
      const zero = (): OwnCounts => ({ nodes: 0, images: 0, eagerOffscreenImages: 0, videos: 0, autoplayVideos: 0, iframes: 0, canvases: 0, animations: 0, infiniteAnimations: 0 });
      const own = new Map<Element | null, OwnCounts>();
      const ownUrls = new Map<Element, { url: string; kind: 'image' | 'video' | 'iframe' | 'script' }[]>();
      const bucket = (el: Element) => {
        const owner = ownerOf.get(el) ?? null;
        let o = own.get(owner);
        if (!o) own.set(owner, (o = zero()));
        return { owner, o };
      };
      const addUrl = (owner: Element | null, url: string | null | undefined, kind: 'image' | 'video' | 'iframe' | 'script') => {
        if (!owner || !url || !/^https?:/i.test(url)) return;
        const list = ownUrls.get(owner) ?? [];
        if (list.length < 6 && !list.some((u) => u.url === url)) list.push({ url, kind });
        ownUrls.set(owner, list);
      };
      const inBody = (el: Element) => !!document.body && document.body !== el && document.body.contains(el);
      for (const el of Array.from(all)) {
        if (!inBody(el)) continue;
        const { owner, o } = bucket(el);
        o.nodes++;
        const tag = el.tagName;
        if (tag === 'IMG') {
          const img = el as HTMLImageElement;
          o.images++;
          if (img.loading !== 'lazy' && img.getBoundingClientRect().top + window.scrollY >= viewportHeight) o.eagerOffscreenImages++;
          addUrl(owner, img.currentSrc || img.src, 'image');
        } else if (tag === 'VIDEO') {
          const v = el as HTMLVideoElement;
          o.videos++;
          if (v.autoplay || (!v.paused && !v.ended)) o.autoplayVideos++;
          addUrl(owner, v.currentSrc || v.src || v.poster, 'video');
        } else if (tag === 'IFRAME') {
          o.iframes++;
          addUrl(owner, (el as HTMLIFrameElement).src, 'iframe');
        } else if (tag === 'CANVAS') {
          o.canvases++;
        } else if (tag === 'SCRIPT' && (el as HTMLScriptElement).src) {
          addUrl(owner, (el as HTMLScriptElement).src, 'script');
        }
      }
      for (const { a, target } of animated) {
        if (!target) continue;
        const { o } = bucket(target);
        o.animations++;
        if (a.effect?.getTiming().iterations === Infinity) o.infiniteAnimations++;
      }
      // Each signature's owned elements, over all its occurrences.
      const ownBySignature = new Map<string, number>();
      for (const [el, info] of elSig) ownBySignature.set(info.signature, (ownBySignature.get(info.signature) ?? 0) + (own.get(el)?.nodes ?? 0));

      const instances: ComponentInstance[] = chosen.map(([el, info]) => {
        const r = el.getBoundingClientRect();
        const top = r.top + window.scrollY;
        const imgs = Array.from(el.querySelectorAll('img'));
        const videos = Array.from(el.querySelectorAll('video'));
        const media = {
          images: imgs.length,
          eagerOffscreenImages: imgs.filter((i) => i.loading !== 'lazy' && i.getBoundingClientRect().top + window.scrollY >= viewportHeight).length,
          videos: videos.length,
          autoplayVideos: videos.filter((v) => v.autoplay || (!v.paused && !v.ended)).length,
          iframes: el.querySelectorAll('iframe').length,
          canvases: el.querySelectorAll('canvas').length,
        };
        const urls: { url: string; kind: 'image' | 'video' | 'iframe' | 'script' }[] = [];
        const push = (url: string | null | undefined, kind: 'image' | 'video' | 'iframe' | 'script') => {
          if (url && /^https?:/i.test(url) && !urls.some((u) => u.url === url)) urls.push({ url, kind });
        };
        // Iframes, scripts and video first: one each costs more than an image.
        for (const f of Array.from(el.querySelectorAll('iframe'))) push((f as HTMLIFrameElement).src, 'iframe');
        for (const s of Array.from(el.querySelectorAll('script[src]'))) push((s as HTMLScriptElement).src, 'script');
        for (const v of videos) push(v.currentSrc || v.src || v.poster, 'video');
        for (const i of imgs) push(i.currentSrc || i.src, 'image');
        const inside = animated.filter((x) => el.contains(x.target!));
        const names = [
          ...new Set(
            inside.map(({ a }) =>
              (a as unknown as { animationName?: string }).animationName ??
              (a as unknown as { transitionProperty?: string }).transitionProperty ??
              a.id ??
              '',
            ),
          ),
        ].filter(Boolean).slice(0, 5);
        const ancestry: string[] = [];
        for (let p = el.parentElement; p && ancestry.length < 6; p = p.parentElement) {
          const s = elSig.get(p);
          if (s) ancestry.unshift(s.signature);
        }
        const inlineScripts = Array.from(el.querySelectorAll('script:not([src])')).length;
        const role = roleOf(el);
        const name = nameOf(el);
        const live = el.matches(LIVE) || !!el.querySelector(LIVE);
        return {
          signature: info.signature,
          method: info.method as ComponentSignature['method'],
          selector: selectorOf(el),
          nodePath: nodePath(el),
          ancestry,
          ...(role ? { role } : {}),
          ...(name ? { name } : {}),
          nodes: info.nodes,
          depth: depthBelow(el),
          rect: { x: Math.round(r.left + window.scrollX), y: Math.round(top), width: Math.round(r.width), height: Math.round(r.height) },
          belowFold: top >= viewportHeight,
          ...(Object.values(media).some((v) => v > 0) ? { media } : {}),
          ...(urls.length ? { resources: urls.slice(0, 6), resourceCount: urls.length } : {}),
          ...(inlineScripts ? { inlineScripts } : {}),
          ...(inside.length
            ? {
                animations: {
                  running: inside.filter(({ a }) => a.playState === 'running').length,
                  infinite: inside.filter(({ a }) => a.effect?.getTiming().iterations === Infinity).length,
                  names,
                },
              }
            : {}),
          ...(live ? { liveRegion: true } : {}),
          tag: el.tagName.toLowerCase(),
          own: own.get(el) ?? zero(),
          ...(ownUrls.get(el)?.length ? { ownResources: ownUrls.get(el) } : {}),
        };
      });

      const structure: PageStructure = {
        landmarks,
        components: [...sigs.values()]
          .sort((a, b) => b.nodes - a.nodes || (a.signature < b.signature ? -1 : 1))
          .slice(0, 40)
          .map((c) => ({ ...c, ownNodes: ownBySignature.get(c.signature) ?? 0 })) as ComponentSignature[],
        frameworks: [...frameworks].sort(),
        instances,
        unowned: own.get(null) ?? zero(),
        ...(drupal ? { drupal } : {}),
      };

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
        structure,
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
