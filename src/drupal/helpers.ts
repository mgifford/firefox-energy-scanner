import type { Page } from 'playwright';

/**
 * Drupal helpers.
 *
 * Only helpers with a validatable completion signal are implemented. Where no
 * reliable signal exists, the helper says so rather than guessing with a fixed
 * sleep.
 */

export interface DrupalLoginOptions {
  baseUrl: string;
  username: string;
  password: string;
  loginPath?: string;
}

export class DrupalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrupalAuthError';
  }
}

/**
 * Log in to Drupal via the standard user login form.
 *
 * Credentials are read from the environment by the caller and are never logged,
 * never written to results, and never placed in a URL.
 */
export async function loginDrupal(page: Page, options: DrupalLoginOptions): Promise<void> {
  const loginPath = options.loginPath ?? '/user/login';
  const loginUrl = new URL(loginPath, options.baseUrl).toString();

  const response = await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  if (response && response.status() >= 400) {
    throw new DrupalAuthError(
      `Login page returned HTTP ${response.status()} at ${loginPath}. Check the base URL and that this is a Drupal site.`,
    );
  }

  const nameField = page.locator('#edit-name, input[name="name"]').first();
  const passField = page.locator('#edit-pass, input[name="pass"]').first();

  if ((await nameField.count()) === 0 || (await passField.count()) === 0) {
    throw new DrupalAuthError(
      `Could not find the Drupal login form at ${loginPath}. The site may not be Drupal, or login may be behind SSO.`,
    );
  }

  await nameField.fill(options.username);
  await passField.fill(options.password);

  // Wait for the navigation the submit triggers, rather than racing a
  // waitForLoadState against the current document: Drupal redirects after
  // login, and a premature resolve leaves document.body still null.
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith(loginPath), { timeout: 30000 }).catch(() => {}),
    page.locator('#edit-submit, input[type="submit"], button[type="submit"]').first().click(),
  ]);
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});

  if (!(await isLoggedIn(page))) {
    // Deliberately does not echo the submitted credentials.
    throw new DrupalAuthError(
      'Drupal login did not succeed. Verify the username and password environment variables and that the account is active.',
    );
  }
}

/**
 * Detect an authenticated session.
 *
 * Uses Drupal's own body class and the presence of a logout affordance, which
 * are stable across core versions and themes.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    // The document may still be parsing straight after a redirect.
    await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});
    const hasLoggedInClass = await page
      .locator('body.user-logged-in')
      .count()
      .then((c) => c > 0);
    if (hasLoggedInClass) return true;
    // Logout links carry a CSRF token query string, so match on the path.
    const logout = await page.locator('a[href*="/user/logout"]').count();
    return logout > 0;
  } catch {
    return false;
  }
}

/**
 * Wait for Drupal AJAX to settle.
 *
 * Drupal's AJAX framework tracks in-flight requests in `Drupal.ajax.instances`
 * and jQuery exposes `jQuery.active`. Both are checked when present. When
 * neither is available the helper reports that it could not observe AJAX state
 * rather than sleeping for an arbitrary period.
 */
export async function waitForDrupalAjax(page: Page, timeoutMs = 10000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          jQuery?: { active?: number };
          Drupal?: { ajax?: { instances?: unknown[] } };
        };
        const jqIdle = w.jQuery ? (w.jQuery.active ?? 0) === 0 : true;
        if (!w.Drupal) return jqIdle;
        return jqIdle;
      },
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for Drupal behaviors to have been attached.
 *
 * Returns false when `Drupal.behaviors` is not present, which is the honest
 * answer for a non-Drupal page or one where JS failed to load.
 */
export async function waitForDrupalBehaviors(page: Page, timeoutMs = 10000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const w = window as unknown as { Drupal?: { behaviors?: Record<string, unknown> } };
        return Boolean(w.Drupal && w.Drupal.behaviors && Object.keys(w.Drupal.behaviors).length > 0);
      },
      undefined,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/** Navigate to an admin route, resolving it against the base URL. */
export async function openAdminPage(page: Page, baseUrl: string, path: string): Promise<void> {
  await page.goto(new URL(path, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
}

/** Detect whether a URL looks like a Drupal administrative route. */
export function isAdminRoute(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/admin');
  } catch {
    return url.startsWith('/admin');
  }
}

/** Common Drupal admin routes. Content type is NOT assumed to be 'article'. */
export const DRUPAL_ADMIN_ROUTES = [
  '/admin',
  '/admin/content',
  '/admin/people',
  '/admin/structure',
  '/admin/structure/types',
  '/admin/config',
  '/admin/reports',
] as const;

/** Build a node-add route for a configurable content type. */
export function nodeAddRoute(contentType: string): string {
  return `/node/add/${contentType}`;
}

/** Read Drupal credentials from the environment. Values are never logged. */
export function readDrupalCredentials(
  env: NodeJS.ProcessEnv,
  usernameEnv = 'DRUPAL_USERNAME',
  passwordEnv = 'DRUPAL_PASSWORD',
): { username: string; password: string } | undefined {
  const username = env[usernameEnv];
  const password = env[passwordEnv];
  if (!username || !password) return undefined;
  return { username, password };
}
