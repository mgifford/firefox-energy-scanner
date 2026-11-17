/**
 * Signs that something outside the test acted on the page during a run.
 *
 * Firefox runs headed by default, so its window can take a click, a scroll or
 * a key press, and a click on a link takes the page somewhere else. On an
 * Apple M2, one diagnose run of the fixture site's /articles/d visited five
 * other pages during its idle window, and its timeline and structure
 * described those pages instead. A run that was acted on is not a
 * measurement of the workload, so it is detected and not used:
 *
 * - navigation: the main frame went to another document after the page
 *   loaded (watched from Playwright, so it survives the navigation itself);
 * - input: trusted pointer presses, wheel turns, key presses or touches
 *   reached the page. The built-in workloads send none, so any is from
 *   outside. Pointer movement is not counted: Firefox synthesises it when
 *   content moves under a resting pointer.
 *
 * Only for workloads that act on the page themselves (journeys) would input be
 * expected, and those are not checked.
 */

import type { Page } from 'playwright';

/** Why a run was not used. load-failed ends an experiment; the others skip one run. */
export class RunInterrupted extends Error {
  override name = 'RunInterrupted';
  constructor(
    readonly reason: 'navigated' | 'input' | 'load-failed',
    message: string,
  ) {
    super(message);
  }
}

export interface InputCounts {
  available: boolean;
  pointer: number;
  wheel: number;
  key: number;
  touch: number;
}

/** Init script: counts trusted input on the top document, passively. */
export function inputWatchInit(): void {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w.top !== w || Object.prototype.hasOwnProperty.call(w, '__webEnergyInput')) return;
  const c = { pointer: 0, wheel: 0, key: 0, touch: 0 };
  Object.defineProperty(w, '__webEnergyInput', { value: c, enumerable: false });
  const on = (type: string, key: keyof typeof c) =>
    w.addEventListener(
      type,
      (e: Event) => {
        if (e.isTrusted) c[key]++;
      },
      { capture: true, passive: true },
    );
  on('pointerdown', 'pointer');
  on('wheel', 'wheel');
  on('keydown', 'key');
  on('touchstart', 'touch');
}

export async function readInput(page: Page): Promise<InputCounts> {
  return page
    .evaluate(() => {
      const c = (window as unknown as { __webEnergyInput?: { pointer: number; wheel: number; key: number; touch: number } }).__webEnergyInput;
      return { available: !!c, pointer: c?.pointer ?? 0, wheel: c?.wheel ?? 0, key: c?.key ?? 0, touch: c?.touch ?? 0 };
    })
    .catch(() => ({ available: false, pointer: 0, wheel: 0, key: 0, touch: 0 }));
}

const sansHash = (u: string) => u.replace(/#.*$/, '');

/**
 * Watches the main frame. Attach it before the page loads and arm() it the
 * moment the page has landed (where goto resolved, after any redirect):
 * every document after that is a navigation away, including one during the
 * load step's wait for the page to settle.
 */
export function watchNavigation(page: Page): { arm: () => void; visited: () => string[]; stop: () => void } {
  let landed: string | undefined;
  const seen: string[] = [];
  const handler = (frame: ReturnType<Page['mainFrame']>) => {
    if (frame !== page.mainFrame() || landed === undefined) return;
    const u = frame.url();
    if (sansHash(u) !== sansHash(landed) && !seen.includes(u)) seen.push(u);
  };
  page.on('framenavigated', handler);
  return {
    arm: () => {
      landed = page.url();
    },
    // A backstop for an event missed: the page is not where it landed.
    visited: () => (landed !== undefined && sansHash(page.url()) !== sansHash(landed) && !seen.includes(page.url()) ? [...seen, page.url()] : [...seen]),
    stop: () => page.off('framenavigated', handler),
  };
}

/** A plain sentence for what happened, or undefined when nothing did. */
export function interference(visited: string[], input: InputCounts): string | undefined {
  const parts: string[] = [];
  const presses = input.pointer + input.touch + input.wheel + input.key;
  if (visited.length) {
    parts.push(
      `the page navigated away, to ${visited.slice(0, 5).join(', ')}${visited.length > 5 ? ', …' : ''}` +
        (presses ? '' : ' (no input reached it, so the page probably navigated itself)'),
    );
  }
  const clicks = input.pointer + input.touch;
  const events = [
    clicks ? `${clicks} click${clicks === 1 ? '' : 's'} or touch${clicks === 1 ? '' : 'es'}` : '',
    input.wheel ? `${input.wheel} scroll-wheel event${input.wheel === 1 ? '' : 's'}` : '',
    input.key ? `${input.key} key press${input.key === 1 ? '' : 'es'}` : '',
  ].filter(Boolean);
  if (events.length) parts.push(`input from outside the test reached the page (${events.join(', ')})`);
  if (!parts.length) return undefined;
  const sentence = parts.join('; and ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. ${
    events.length ? 'Something acted on the Firefox window during the run: do not click, scroll or type in it while a measurement runs (or use --headless).' : 'A page that leaves itself cannot be measured with this workload.'
  }`;
}

/** Turns a lost execution context (the page navigated mid-call) into an interrupted run. */
export async function duringRun<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const m = (e as Error).message ?? '';
    if (/Execution context was destroyed|navigation|Target page, context or browser has been closed/i.test(m)) {
      throw new RunInterrupted('navigated', 'The page navigated while it was being checked: something acted on the Firefox window, or the page navigated itself.');
    }
    throw e;
  }
}

/**
 * Can the address be reached at all? A connection that is refused or a name
 * that does not resolve fails every run, so it is said before any run starts.
 * Returns why not, or undefined.
 */
export async function unreachable(url: string, timeoutMs = 15_000): Promise<string | undefined> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return undefined;
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (e as { code?: string }).code ?? (e as Error).name;
    if (code === 'ECONNREFUSED') return `${url} refused the connection. Is the site running?`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${new URL(url).hostname} does not resolve to an address.`;
    if (code === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `${url} did not answer within ${timeoutMs / 1000} s.`;
    return `${url} could not be reached (${code ?? (e as Error).message}).`;
  }
}
