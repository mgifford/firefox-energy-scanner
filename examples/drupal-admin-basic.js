/**
 * drupal-admin-basic
 *
 * The reference Drupal administrative journey. Authentication happens in
 * setup(), outside the measured region, so login cost is not attributed to
 * the workload.
 *
 * This journey is READ-ONLY: it does not create or modify content.
 *
 * Requires DRUPAL_BASE_URL, DRUPAL_USERNAME and DRUPAL_PASSWORD.
 */
import { defineJourney } from '../dist/core/journey.js';
import {
  loginDrupal,
  waitForDrupalBehaviors,
  readDrupalCredentials,
} from '../dist/drupal/helpers.js';

export default defineJourney({
  name: 'drupal-admin-basic',
  description: 'Authenticated read-only pass over core Drupal administrative pages.',

  async setup({ page, baseUrl, env }) {
    const creds = readDrupalCredentials(env);
    if (!creds) {
      throw new Error(
        'Set DRUPAL_USERNAME and DRUPAL_PASSWORD to run the authenticated Drupal journey.',
      );
    }
    await loginDrupal(page, {
      baseUrl,
      username: creds.username,
      password: creds.password,
    });
  },

  async run({ page, measure, url }) {
    await measure('admin', async () => {
      await page.goto(url('/admin'), { waitUntil: 'domcontentloaded' });
      await waitForDrupalBehaviors(page);
    });

    await measure('admin-content', async () => {
      await page.goto(url('/admin/content'), { waitUntil: 'domcontentloaded' });
      await waitForDrupalBehaviors(page);
    });

    // Filtering is measured separately from loading, because the interaction
    // cost is the interesting signal and it is much smaller than a navigation.
    await measure('content-filter', async () => {
      const title = page.locator('input[name="title"], #edit-title').first();
      if ((await title.count()) === 0) return; // filter absent on this install
      await title.fill('test');
      const submit = page
        .locator('#edit-submit-content, input[type="submit"][value*="Filter" i], button[type="submit"]')
        .first();
      if ((await submit.count()) > 0) {
        await submit.click();
        await page.waitForLoadState('domcontentloaded');
      }
    });

    await measure('admin-people', async () => {
      await page.goto(url('/admin/people'), { waitUntil: 'domcontentloaded' });
      await waitForDrupalBehaviors(page);
    });

    await measure('admin-structure', async () => {
      await page.goto(url('/admin/structure'), { waitUntil: 'domcontentloaded' });
      await waitForDrupalBehaviors(page);
    });

    await measure('admin-config', async () => {
      await page.goto(url('/admin/config'), { waitUntil: 'domcontentloaded' });
      await waitForDrupalBehaviors(page);
    });
  },
});
