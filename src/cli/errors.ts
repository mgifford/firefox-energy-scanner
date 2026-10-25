/**
 * Turn a raw Playwright error into one a person can act on.
 *
 * The scan runs Firefox in a visible window by default, so closing that
 * window (or Firefox quitting) is the most common way a local run dies. The
 * raw "Target page, context or browser has been closed" says neither what
 * happened nor what to do.
 */
export function friendlyError(message: string): string {
  if (/target page, context or browser has been closed|browser has been closed|browser has disconnected/i.test(message)) {
    return (
      'Firefox closed before the run finished, so nothing was saved. If its window was closed, run the ' +
      'command again and leave the window open while it works, or add --headless to run without a window.'
    );
  }
  return message;
}
