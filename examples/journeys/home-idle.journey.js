/**
 * home-idle
 *
 * Load a site's home page, check it rendered, then leave it open for an
 * idle window: the workload for animations, carousels and timers.
 *
 * Written to the journey rules (web-energy journey-check):
 * - semantic locators (roles, labels, visible text), never markup positions;
 * - setup outside the measured region, measure() around each part of the task;
 * - explicit checks that the task succeeded;
 * - no fixed waits except the intentional idle window;
 * - no credentials or session data in the file: anything secret comes from
 *   the environment, in setup().
 *
 * Run it: node dist/cli/index.js journey examples/journeys/home-idle.journey.js --url https://example.org
 */
import { defineJourney } from '../../dist/core/journey.js';

const IDLE_MS = 10000;

export default defineJourney({
  name: 'home-idle',
  description: 'Load the home page, check its main landmark, then idle.',

  async run({ page, measure, url }) {
    await measure('load', async () => {
      await page.goto(url('/'), { waitUntil: 'load' });
      // The task succeeded only if the page has its main content.
      await page.getByRole('main').first().waitFor({ state: 'visible' });
    });

    await measure('idle', async () => {
      // Intentional idle window: the page left open is the workload.
      await page.waitForTimeout(IDLE_MS);
    });
  },
});
