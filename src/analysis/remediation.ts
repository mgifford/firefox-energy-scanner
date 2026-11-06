/**
 * What a developer could do about a component, why it tends to cost browser
 * work, and how to find out whether it does here.
 *
 * Each remedy is triggered by recorded facts (fields of a component record or
 * the Lighthouse findings tied to it), never by a score. Its rationale says
 * why such work is usually costly; the `verify` text names the measured
 * comparison that settles whether this change saves energy on this site.
 * Until that comparison runs, a remedy is a lead, not a saving.
 */

import type { ComponentRecord } from './components.js';

export interface Remediation {
  id: string;
  title: string;
  /** What to change. */
  action: string;
  /** Why this kind of thing tends to cost client work. */
  rationale: string;
  /** How to measure the effect, with the tool's comparison mode. */
  verify: string;
  /** The kind of measured experiment that would test it, when one fits. */
  experiment?: 'animation' | 'reduced-motion' | 'lazy-loading' | 'facade' | 'pagination' | 'autoplay' | 'script';
  /** Lighthouse audits and documentation behind it. */
  references: string[];
}

const COMPARE =
  'Measure it with `web-energy experiment --from <result.json> --item <n>` (interleaved, 10 or more runs per side) on a machine that measures energy, or `web-energy compare` between two builds.';

export const REMEDIATIONS: Record<string, Remediation> = {
  'stop-endless-animation': {
    id: 'stop-endless-animation',
    title: 'Stop endless animations',
    action:
      'Let the animation run a few times and stop, pause it when it is off screen or the tab is hidden, and stop it under prefers-reduced-motion. Animate only transform and opacity.',
    rationale:
      'A running animation keeps the refresh driver and compositor producing frames for as long as the page is open, even when nobody is looking at it.',
    verify: `Measure an idle window with the animation running and with it stopped. ${COMPARE}`,
    experiment: 'animation',
    references: ['docs/what-costs-energy.md#where-to-look-first-in-order', 'WSG 2.10 ensure-animation-is-proportionate-and-easy-to-control', 'WCAG 2.2.2 Pause, Stop, Hide', 'WCAG 2.3.3 Animation from Interactions'],
  },
  'composite-animation': {
    id: 'composite-animation',
    title: 'Animate properties the compositor can run',
    action: 'Replace animations of width, height, top, left, margin or colour with transform and opacity.',
    rationale: 'Animating layout properties forces style, layout and paint on every frame on the main thread; transform and opacity can run on the compositor.',
    verify: `Measure the animated state before and after. ${COMPARE}`,
    experiment: 'animation',
    references: ['Lighthouse non-composited-animations', 'WSG 2.10 ensure-animation-is-proportionate-and-easy-to-control'],
  },
  'respect-reduced-motion': {
    id: 'respect-reduced-motion',
    title: 'Honour prefers-reduced-motion',
    action: 'Wrap motion in @media (prefers-reduced-motion: no-preference), and give a static alternative.',
    rationale: 'People who ask for less motion should get it, and a page with motion off does less rendering work.',
    verify: 'Run `web-energy experiment <url> --kind reduced-motion`: it also shows whether the page responds to the preference.',
    experiment: 'reduced-motion',
    references: ['WSG 3.9 use-media-queries-that-support-sustainability-goals', 'WCAG 2.3.3 Animation from Interactions'],
  },
  'lazy-load-images': {
    id: 'lazy-load-images',
    title: 'Lazy-load images below the first screen',
    action: 'Add loading="lazy" (and decoding="async") to images below the first screen. Never to the LCP image.',
    rationale: 'Images nobody scrolls to are still downloaded and decoded at load: transfer, decode and memory for nothing.',
    verify: `Compare the page load with and without loading="lazy". ${COMPARE}`,
    experiment: 'lazy-loading',
    references: ['Lighthouse image-delivery-insight', 'WSG 2.9 optimize-media-to-reduce-resource-use', 'WSG 3.7 defer-the-loading-of-non-critical-resources'],
  },
  'no-autoplay': {
    id: 'no-autoplay',
    title: 'Do not autoplay video',
    action: 'Show a poster image with a play button; set preload="none" or "metadata"; never autoplay with sound, and give a pause control.',
    rationale: 'Video decode runs for as long as it plays, and its transfer is usually the largest on the page.',
    verify: `Compare the page with autoplay on and off over the same idle window. ${COMPARE}`,
    experiment: 'autoplay',
    references: ['WSG 2.9 optimize-media-to-reduce-resource-use', 'WCAG 2.2.2 Pause, Stop, Hide', 'WCAG 1.4.2 Audio Control'],
  },
  'facade-iframe': {
    id: 'facade-iframe',
    title: 'Load embeds on interaction',
    action: 'Replace the iframe with a static facade (image and button) and load the embed when someone activates it; otherwise loading="lazy".',
    rationale: 'Each iframe is another document with its own scripts, style and layout; third-party embeds often load far more than they show.',
    verify: `Compare the page with the facade and with the live embed. ${COMPARE}`,
    experiment: 'facade',
    references: ['Lighthouse third-parties-insight', 'WSG 3.5 treat-third-parties-the-same-as-first-parties', 'WSG 3.7 defer-the-loading-of-non-critical-resources'],
  },
  'reduce-dom': {
    id: 'reduce-dom',
    title: 'Render fewer elements',
    action:
      'Paginate or virtualise long lists, render menus and other hidden content on demand rather than on every page, and remove wrappers that exist only for styling.',
    rationale: 'Every element is re-examined on style recalculation and layout, so a large subtree costs work on load and on every later change.',
    verify: `Compare the template with the smaller markup (a paginated or virtualised variant). ${COMPARE}`,
    experiment: 'pagination',
    references: ['Lighthouse dom-size-insight', 'docs/what-costs-energy.md#where-to-look-first-in-order'],
  },
  'reserve-space': {
    id: 'reserve-space',
    title: 'Reserve space so nothing shifts',
    action: 'Give images and embeds width and height (or aspect-ratio), and reserve room for content that arrives later.',
    rationale: 'A layout shift is a relayout and repaint of everything below it, and moves content under the reader.',
    verify: 'Check the layout-shift findings disappear in a fresh Lighthouse run; measure with compare if the shift repeats.',
    references: ['Lighthouse cls-culprits-insight', 'Lighthouse unsized-images'],
  },
  'resize-images': {
    id: 'resize-images',
    title: 'Serve images at the size shown',
    action: 'Use srcset and sizes, and a modern format, so no image is decoded at many times its displayed size.',
    rationale: 'Images are decoded at natural size whatever CSS does, so an oversized image costs CPU and memory as well as bytes.',
    verify: 'Compare transfer and decode before and after; measure with compare for energy.',
    experiment: 'lazy-loading',
    references: ['Lighthouse image-delivery-insight', 'WSG 2.9 optimize-media-to-reduce-resource-use'],
  },
  'defer-script': {
    id: 'defer-script',
    title: 'Defer or split the script this component loads',
    action: 'Load the script when the component is used or scrolled into view, or split out the part only this component needs.',
    rationale: 'Script evaluation was the largest main-thread cost Lighthouse found for it; work done at load for a component nobody uses is waste.',
    verify: `Compare the page with the script deferred. ${COMPARE}`,
    experiment: 'script',
    references: ['Lighthouse bootup-time', 'Lighthouse long-tasks', 'WSG 3.3 modularize-bandwidth-heavy-components', 'WSG 3.7 defer-the-loading-of-non-critical-resources'],
  },
  'audit-global-script': {
    id: 'audit-global-script',
    title: 'Check whether every page needs this script',
    action:
      'Find which component or library needs it (in Drupal, the #attached libraries), attach it only there, and defer what is not needed to show the page.',
    rationale: 'A script loaded on every page costs its parse and evaluation on every visit, used or not.',
    verify: `Compare a page with the script removed or deferred. ${COMPARE}`,
    experiment: 'script',
    references: ['Lighthouse bootup-time', 'Lighthouse long-tasks', 'Lighthouse third-parties-insight', 'WSG 3.2 minify-and-remove-unused-code', 'WSG 3.12 use-dependencies-sparingly-and-maintain-them'],
  },
  'batch-layout-reads': {
    id: 'batch-layout-reads',
    title: 'Stop forcing synchronous layout',
    action: 'At the source location named, read layout (offsetHeight, getBoundingClientRect) before writing styles, not in between, or move the work into requestAnimationFrame.',
    rationale: 'Reading layout right after changing styles forces the browser to lay the page out again, synchronously, on the main thread.',
    verify: 'Check the forced-reflow finding disappears; measure with compare if the code runs often.',
    experiment: 'script',
    references: ['Lighthouse forced-reflow-insight'],
  },
  'subset-fonts': {
    id: 'subset-fonts',
    title: 'Load fewer font files, and only the glyphs used',
    action: 'Subset fonts to the characters the site uses, serve WOFF2, drop weights and styles no page uses, and use font-display: swap.',
    rationale: 'Every font file is downloaded and parsed before text in it can render, on every page that loads it.',
    verify: 'Compare transfer and render timing before and after; measure with compare for energy.',
    references: ['Lighthouse font-display-insight', 'WSG 2.11 use-optimized-web-typography'],
  },
  'trim-shared-css': {
    id: 'trim-shared-css',
    title: 'Split the stylesheet every page loads',
    action: 'Move rules only some templates need into per-template stylesheets, and remove rules no page uses.',
    rationale: 'The style system matches every selector a page loads against its elements; rules for other templates are work for nothing.',
    verify: `Compare a page with the trimmed stylesheet. ${COMPARE}`,
    references: ['Lighthouse unused-css-rules', 'WSG 3.2 minify-and-remove-unused-code'],
  },
  'icon-library': {
    id: 'icon-library',
    title: 'Replace the icon library with the icons used',
    action: 'Ship the few icons the site shows as inline SVG or a small sprite, instead of whole icon-font or icon-script libraries on every page.',
    rationale: 'Icon libraries loaded by script parse and evaluate thousands of icon definitions on every page to draw a handful.',
    verify: `Compare a page with the library refused (an upper bound) and then with the replacement. ${COMPARE}`,
    experiment: 'script',
    references: ['Lighthouse unused-javascript', 'WSG 3.2 minify-and-remove-unused-code', 'WSG 3.12 use-dependencies-sparingly-and-maintain-them'],
  },
  'compare-with-family': {
    id: 'compare-with-family',
    title: 'Find what this page adds to its template',
    action: 'Compare it with its family’s representative page: the difference in elements, requests or bytes is the content or component to look at.',
    rationale: 'Pages built from one template should cost about the same; one far from the rest carries something extra.',
    verify: 'Measure it beside the representative page with `web-energy measure` (10 or more runs each).',
    references: ['docs/page-families.md'],
  },
};

/** Findings only: context (the LCP element, a passing DOM audit) triggers no remedy. */
const hasEvidence = (r: ComponentRecord, ...audits: string[]) => r.evidence.some((e) => e.kind === 'finding' && audits.includes(e.audit));
const hasScriptEvidence = (r: ComponentRecord) => r.evidence.some((e) => e.kind === 'finding' && e.matchedBy === 'script-in-component');

/** The remedies a component's recorded facts point to, most specific first. */
export function remediationsFor(r: ComponentRecord): Remediation[] {
  const out: string[] = [];
  if (r.animations?.infinite) out.push('stop-endless-animation', 'respect-reduced-motion');
  if (hasEvidence(r, 'non-composited-animations')) out.push('composite-animation');
  if (r.media?.autoplayVideos) out.push('no-autoplay');
  if (r.media?.iframes) out.push('facade-iframe');
  if (hasEvidence(r, 'layout-shifts', 'cls-culprits-insight', 'unsized-images')) out.push('reserve-space');
  if (hasEvidence(r, 'image-delivery-insight')) out.push('resize-images');
  if (r.media?.eagerOffscreenImages) out.push('lazy-load-images');
  if (hasScriptEvidence(r)) out.push('defer-script');
  if (hasEvidence(r, 'forced-reflow-insight')) out.push('batch-layout-reads');
  if ((r.shareOfPage !== undefined && r.shareOfPage >= 0.25) || r.nodes.median >= 800 || hasEvidence(r, 'dom-size-insight')) out.push('reduce-dom');
  return [...new Set(out)].map((id) => REMEDIATIONS[id]!);
}
