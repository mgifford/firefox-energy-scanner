/** The fixture server reports an occupied port; it never takes one over. */
import { describe, it, expect } from 'vitest';
import { startFixtureSite } from './fixtures/site/server.mjs';

describe('the fixture server', () => {
  it('reports an occupied port with a clear action, and leaves the listener alone', async () => {
    const site = await startFixtureSite({ port: 0 });
    expect(site.port).toBeGreaterThan(0);
    try {
      await expect(startFixtureSite({ port: site.port })).rejects.toThrow(/already in use/);
      // The first server still answers: the second did not take it over.
      const res = await fetch(`http://127.0.0.1:${site.port}/articles/d`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('data-component-id="live-chart"');
    } finally {
      await site.close();
    }
  });
});
