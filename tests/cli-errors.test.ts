import { describe, it, expect } from 'vitest';
import { friendlyError } from '../src/cli/errors.js';

describe('friendlyError', () => {
  it('explains a Firefox window closed mid-run', () => {
    const m = friendlyError('page.waitForTimeout: Target page, context or browser has been closed');
    expect(m).toMatch(/Firefox closed before the run finished/);
    expect(m).toMatch(/--headless/);
  });

  it('leaves other errors as they are', () => {
    expect(friendlyError('net::ERR_NAME_NOT_RESOLVED')).toBe('net::ERR_NAME_NOT_RESOLVED');
  });
});
