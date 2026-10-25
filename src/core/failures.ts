/**
 * Step-failure wording, shared by the runner (which writes it) and the
 * reports (which re-read results written before this wording existed).
 */

export const STEP_FAILED_PREFIX = 'Step failed: ';
export const NOT_A_PAGE_PREFIX = 'Not a web page: ';
export const BLOCKED_PREFIX = 'Blocked: ';

/**
 * The warning for a page the network guard refused to load: the URL, or a
 * redirect from it, leads to a private or local address.
 */
export function describeBlocked(reason: string): string {
  return (
    BLOCKED_PREFIX +
    `${reason}. Public scans only reach public internet addresses, so it was not measured. ` +
    'To measure a local or development site, run the scanner on your own machine.'
  );
}

/**
 * Turn a navigation error into a warning a reader can act on.
 *
 * A URL that serves a file (typically a PDF) makes Firefox start a download
 * instead of rendering, and Playwright reports that as "Download is starting".
 * There is no page to measure, so say that rather than echoing the raw error.
 */
export function describeStepFailure(message: string): string {
  if (/download is starting/i.test(message)) {
    return (
      NOT_A_PAGE_PREFIX +
      'the URL starts a file download (for example a PDF) instead of rendering a page, so ' +
      'there is nothing for the browser to lay out or paint. It was not measured.'
    );
  }
  return STEP_FAILED_PREFIX + message;
}

/**
 * Normalise a stored warning. Results written before downloads were detected
 * carry Playwright's raw "Step failed: page.goto: Download is starting" text.
 */
export function readableFailure(warning: string): string {
  if (warning.startsWith(STEP_FAILED_PREFIX)) {
    return describeStepFailure(warning.slice(STEP_FAILED_PREFIX.length));
  }
  return warning;
}

/** True when a failure means the URL is a file, not a page. */
export function isNotAPage(warning: string | undefined): boolean {
  return !!warning && readableFailure(warning).startsWith(NOT_A_PAGE_PREFIX);
}

/** True when the network guard refused the page itself. */
export function isBlocked(warning: string | undefined): boolean {
  return !!warning && warning.startsWith(BLOCKED_PREFIX);
}
