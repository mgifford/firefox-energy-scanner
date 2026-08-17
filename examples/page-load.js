/**
 * page-load
 *
 * Minimal journey for comparing two deployments of the same page. It navigates
 * to a relative route, so both targets must expose the same path — which is the
 * normal case for two previews of one application.
 */
import { defineJourney } from '../dist/core/journey.js';

export default defineJourney({
  name: 'page-load',
  description: 'Load one route and let it settle.',

  async run({ page, measure, url }) {
    await measure('load', async () => {
      await page.goto(url('index.html'), { waitUntil: 'domcontentloaded' });
    });
  },
});
