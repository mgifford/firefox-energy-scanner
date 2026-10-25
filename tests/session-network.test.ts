import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserSession } from '../src/collect/session.js';
import { defaultConfig } from '../src/core/config.js';

/**
 * Network attribution without a browser: a fake context emits the same
 * request events Playwright does, in the order that caused the issue #6 leak.
 */
function fakeRequest(url: string, bytes: number) {
  return {
    url: () => url,
    resourceType: () => 'document',
    response: async () => ({ status: () => 200 }),
    sizes: async () => ({ responseBodySize: bytes, responseHeadersSize: 0 }),
    timing: () => ({ responseEnd: 10 }),
  };
}

function harness() {
  const session = new BrowserSession({ config: defaultConfig() });
  const context = new EventEmitter();
  (session as unknown as { attachNetworkListeners(c: unknown): void }).attachNetworkListeners(context);
  return { session, context };
}

describe('per-step network attribution', () => {
  it('counts a request in the step that issued it', async () => {
    const { session, context } = harness();
    session.beginCollection('https://example.org/');
    const req = fakeRequest('https://example.org/', 1000);
    context.emit('request', req);
    context.emit('requestfinished', req);
    const net = await session.endCollection(false);
    expect(net.requests).toBe(1);
    expect(net.transferBytes).toBe(1000);
  });

  it('does not bill a late-finishing download to the next step', async () => {
    const { session, context } = harness();

    // Step 1 issues a PDF request; the navigation fails before it finishes.
    session.beginCollection('https://example.org/');
    const pdf = fakeRequest('https://example.org/report.pdf', 569_000);
    context.emit('request', pdf);
    const first = await session.endCollection(false);

    // Step 2 starts; the PDF body completes while it is running.
    session.beginCollection('https://example.org/');
    const page = fakeRequest('https://example.org/next', 2000);
    context.emit('request', page);
    context.emit('requestfinished', pdf);
    context.emit('requestfinished', page);
    const second = await session.endCollection(false);

    expect(first.transferBytes).toBe(0);
    expect(second.requests).toBe(1);
    expect(second.transferBytes).toBe(2000);
  });

  it('ignores requests issued between steps', async () => {
    const { session, context } = harness();
    const beacon = fakeRequest('https://example.org/beacon', 50);
    context.emit('request', beacon);
    session.beginCollection('https://example.org/');
    context.emit('requestfinished', beacon);
    const net = await session.endCollection(false);
    expect(net.requests).toBe(0);
  });

  it('waits for in-flight size lookups before summarising', async () => {
    const { session, context } = harness();
    session.beginCollection('https://example.org/');
    const slow = {
      ...fakeRequest('https://example.org/slow', 3000),
      sizes: () => new Promise((r) => setTimeout(() => r({ responseBodySize: 3000, responseHeadersSize: 0 }), 20)),
    };
    context.emit('request', slow);
    context.emit('requestfinished', slow);
    const net = await session.endCollection(false);
    expect(net.transferBytes).toBe(3000);
  });
});

describe('public-only mode: pages the network guard refused', () => {
  const MAIN = { name: 'main frame' };

  function guarded() {
    const { session, context } = harness();
    const blocked: { target: string; reason: string; at: number }[] = [];
    Object.assign(session as unknown as Record<string, unknown>, {
      guard: { blocked },
      page: { mainFrame: () => MAIN, url: () => '' },
    });
    return { session, context, blocked };
  }

  const refusedResponse = (url: string, navigation: boolean) => ({
    url: () => url,
    headers: () => ({ 'x-blocked-by': 'firefox-energy-scanner' }),
    request: () => ({ isNavigationRequest: () => navigation, frame: () => MAIN }),
  });

  it('names the reason when the page itself got the guard’s refusal (plain HTTP)', () => {
    const { session, context, blocked } = guarded();
    session.beginCollection('');
    blocked.push({ target: 'mysite.ddev.site:80', reason: 'mysite.ddev.site is a local or development name (.ddev.site)', at: 0 });
    context.emit('response', refusedResponse('http://mysite.ddev.site/', true));
    expect(session.documentBlockReason()).toMatch(/\.ddev\.site/);
  });

  it('blames the guard for a failed HTTPS navigation only when it refused something', () => {
    const { session, blocked } = guarded();
    session.beginCollection('');
    expect(session.documentBlockReason('page.goto: NS_ERROR_PROXY_FORBIDDEN')).toBeUndefined();
    blocked.push({ target: 'intranet.example.com:443', reason: 'intranet.example.com resolves to 10.0.0.2, a private or reserved address', at: 0 });
    expect(session.documentBlockReason('page.goto: NS_ERROR_PROXY_FORBIDDEN')).toMatch(/10\.0\.0\.2/);
    // An unrelated failure is not turned into a block.
    expect(session.documentBlockReason('page.goto: Timeout 30000ms exceeded')).toBeUndefined();
  });

  it('counts only refusals from the current step, and not a refused subresource as the page', () => {
    const { session, context, blocked } = guarded();
    session.beginCollection('');
    blocked.push({ target: '127.0.0.1:80', reason: 'old', at: 0 });
    session.beginCollection('');
    expect(session.blockedInStep()).toEqual([]);
    blocked.push({ target: 'localhost:3000', reason: 'localhost is a local or development name', at: 1 });
    context.emit('response', refusedResponse('http://localhost:3000/app.js', false));
    expect(session.blockedInStep()).toHaveLength(1);
    expect(session.documentBlockReason()).toBeUndefined();
  });
});
