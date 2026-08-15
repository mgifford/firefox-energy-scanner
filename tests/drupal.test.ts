import { describe, it, expect } from 'vitest';
import {
  isAdminRoute,
  nodeAddRoute,
  readDrupalCredentials,
  DRUPAL_ADMIN_ROUTES,
} from '../src/drupal/helpers.js';

describe('isAdminRoute', () => {
  it('detects admin paths in absolute URLs', () => {
    expect(isAdminRoute('https://e.com/admin')).toBe(true);
    expect(isAdminRoute('https://e.com/admin/content')).toBe(true);
    expect(isAdminRoute('https://e.com/node/1')).toBe(false);
  });

  it('handles bare paths', () => {
    expect(isAdminRoute('/admin/people')).toBe(true);
    expect(isAdminRoute('/user/login')).toBe(false);
  });
});

describe('nodeAddRoute', () => {
  it('does not assume an "article" content type exists', () => {
    expect(nodeAddRoute('page')).toBe('/node/add/page');
    expect(nodeAddRoute('custom_type')).toBe('/node/add/custom_type');
  });
});

describe('DRUPAL_ADMIN_ROUTES', () => {
  it('covers the documented core admin routes', () => {
    expect(DRUPAL_ADMIN_ROUTES).toContain('/admin');
    expect(DRUPAL_ADMIN_ROUTES).toContain('/admin/content');
    expect(DRUPAL_ADMIN_ROUTES).toContain('/admin/people');
    expect(DRUPAL_ADMIN_ROUTES.every((r) => isAdminRoute(r))).toBe(true);
  });
});

describe('readDrupalCredentials', () => {
  it('reads the configured environment variables', () => {
    const creds = readDrupalCredentials({ DRUPAL_USERNAME: 'u', DRUPAL_PASSWORD: 'p' });
    expect(creds).toEqual({ username: 'u', password: 'p' });
  });

  it('supports custom variable names', () => {
    const creds = readDrupalCredentials({ A: 'u', B: 'p' }, 'A', 'B');
    expect(creds).toEqual({ username: 'u', password: 'p' });
  });

  it('returns undefined when either value is missing', () => {
    expect(readDrupalCredentials({ DRUPAL_USERNAME: 'u' })).toBeUndefined();
    expect(readDrupalCredentials({ DRUPAL_PASSWORD: 'p' })).toBeUndefined();
    expect(readDrupalCredentials({})).toBeUndefined();
  });
});

/**
 * Regression test for a real failure against a Drupal 12 Tugboat preview:
 * logout links carry a CSRF token query string, so an `href$="/user/logout"`
 * selector never matches and login detection wrongly reported failure.
 */
describe('logout link matching', () => {
  const SELECTOR_SUBSTRING = '/user/logout';

  it('matches logout URLs that carry a CSRF token', () => {
    const real = '/user/logout?token=joCKQeFpgLkovjROaFuAMESanP1ubu-rkucLjnzGLqo';
    expect(real.includes(SELECTOR_SUBSTRING)).toBe(true);
    // The original suffix-anchored form would have missed it.
    expect(real.endsWith('/user/logout')).toBe(false);
  });

  it('still matches a plain logout URL', () => {
    expect('/user/logout'.includes(SELECTOR_SUBSTRING)).toBe(true);
  });
});
