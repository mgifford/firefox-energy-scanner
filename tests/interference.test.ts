import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { RunInterrupted, duringRun, interference, unreachable } from '../src/collect/interference.js';

const none = { available: true, pointer: 0, wheel: 0, key: 0, touch: 0 };

describe('interference', () => {
  it('is nothing when the page was left alone', () => {
    expect(interference([], none)).toBeUndefined();
  });

  it('names where the page went, and the input that reached it', () => {
    expect(interference(['http://a.test/compute', 'http://a.test/table'], { ...none, pointer: 2, wheel: 5 })).toBe(
      'The page navigated away, to http://a.test/compute, http://a.test/table; and input from outside the test reached the page (2 clicks or touches, 5 scroll-wheel events). Something acted on the Firefox window during the run: do not click, scroll or type in it while a measurement runs (or use --headless).',
    );
  });

  it('says a page that left without input probably navigated itself', () => {
    expect(interference(['http://a.test/light'], none)).toMatch(/no input reached it, so the page probably navigated itself\). A page that leaves itself/);
    expect(interference([], { ...none, key: 1 })).toMatch(/^Input from outside the test reached the page \(1 key press\)/);
  });

  it('turns a lost execution context into an interrupted run, and leaves other errors alone', async () => {
    await expect(duringRun(async () => { throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'); })).rejects.toBeInstanceOf(RunInterrupted);
    await expect(duringRun(async () => { throw new Error('something else'); })).rejects.toThrow('something else');
    expect(await duringRun(async () => 3)).toBe(3);
  });
});

describe('unreachable', () => {
  it('says plainly when nothing is listening', async () => {
    // A port that was free a moment ago: nothing listens there now.
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    expect(await unreachable(`http://127.0.0.1:${port}/articles/d`)).toBe(`http://127.0.0.1:${port}/articles/d refused the connection. Is the site running?`);
  });

  it('is undefined for a site that answers, whatever its status', async () => {
    const { startFixtureSite } = await import('./fixtures/site/server.mjs');
    const site = await startFixtureSite({ port: 20_000 + Math.floor(Math.random() * 1_000) });
    try {
      expect(await unreachable(`http://127.0.0.1:${site.port}/light`)).toBeUndefined();
      expect(await unreachable(`http://127.0.0.1:${site.port}/nope`)).toBeUndefined();
    } finally {
      await site.close();
    }
  });
});
