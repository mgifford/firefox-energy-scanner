/**
 * A browser for tests that need a real DOM: Firefox when Playwright's Firefox
 * is installed (as in CI's e2e job), otherwise the Chromium Playwright finds,
 * otherwise none, and the tests that need one are skipped. Set
 * WEB_ENERGY_TEST_ENGINE=firefox|chromium to choose. No energy is measured
 * here: these tests check what the DOM does.
 */
import { existsSync } from 'node:fs';
import { chromium, firefox, type Browser } from 'playwright';
import { findChromium } from '../../src/trace/run.js';

const HOSTS = ['www.site.test', 'thirdparty.test'];

/** The Chromium the trace command would use: the system's, or any Playwright build. */
const CHROMIUM = await findChromium();

function installed(kind: 'firefox' | 'chromium'): boolean {
  if (kind === 'chromium') return !!CHROMIUM;
  try {
    return existsSync(firefox.executablePath());
  } catch {
    return false;
  }
}

export const ENGINE: 'firefox' | 'chromium' | undefined = (() => {
  const asked = process.env.WEB_ENERGY_TEST_ENGINE;
  if (asked === 'firefox' || asked === 'chromium') return installed(asked) ? asked : undefined;
  if (installed('firefox')) return 'firefox';
  if (installed('chromium')) return 'chromium';
  return undefined;
})();

/** Launch the test browser, with the fixture's host names resolved to this machine. */
export async function launchTestBrowser(): Promise<Browser> {
  if (ENGINE === 'firefox') {
    return firefox.launch({ headless: true, firefoxUserPrefs: { 'network.dns.localDomains': HOSTS.join(',') } });
  }
  return chromium.launch({ headless: true, executablePath: CHROMIUM, args: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(',')}`] });
}
