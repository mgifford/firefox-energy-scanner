/**
 * Make every horizontally scrolling table wrapper reachable from the keyboard.
 *
 * A wide table on a narrow screen scrolls inside its `<div class="scroll">`.
 * Without focus, someone using a keyboard cannot scroll it to the columns
 * off screen (WCAG 2.1.1). Each wrapper becomes a named region that takes
 * focus: its name is its table's caption, so a screen reader announces what
 * the region holds, and the report's `:focus-visible` outline shows where focus is.
 */
export function focusableScrollRegions(html: string): string {
  return html.replace(/<div class="scroll">(\s*<table\b[^>]*>\s*<caption>([\s\S]*?)<\/caption>)?/g, (_all, table: string | undefined, caption: string | undefined) => {
    const name = (caption ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || 'Table';
    return `<div class="scroll" role="region" tabindex="0" aria-label="${name.replace(/"/g, '&quot;')}">${table ?? ''}`;
  });
}
