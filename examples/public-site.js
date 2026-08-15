/**
 * public-site
 *
 * Minimal unauthenticated journey, useful for checking the toolchain against
 * an arbitrary public website without needing credentials.
 */
import { defineJourney } from '../dist/core/journey.js';

export default defineJourney({
  name: 'public-site',
  description: 'Load the home page and follow the first in-page link.',

  async run({ page, measure, url }) {
    await measure('home', async () => {
      await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    });

    await measure('scroll', async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    });
  },
});
