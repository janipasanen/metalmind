/**
 * Pure scrollback paging math for the chat transcript (#159). scrollOffset counts
 * messages scrolled *up* from the live tail: 0 shows the most recent page;
 * increasing it reveals older messages. The result is clamped so you can't scroll
 * past either end.
 */
export interface PageWindow {
  start: number;
  end: number;
  hiddenAbove: number;
  hiddenBelow: number;
  /** The clamped offset actually used (so callers can correct overscroll). */
  offset: number;
}

export function pageWindow(total: number, scrollOffset: number, pageSize: number): PageWindow {
  const size = Math.max(1, pageSize);
  const maxOffset = Math.max(0, total - size);
  const offset = Math.min(Math.max(0, Math.floor(scrollOffset)), maxOffset);
  const end = total - offset;
  const start = Math.max(0, end - size);
  return { start, end, hiddenAbove: start, hiddenBelow: total - end, offset };
}
