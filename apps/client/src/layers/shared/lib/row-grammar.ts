/**
 * The sidebar's one row template, and the truncation budget that keeps it
 * readable at 272px.
 *
 * `[glyph] [who] [› title] [trailing]` — every row in the sidebar is this
 * shape, whatever it points at. The glyph carries the type, so the chrome never
 * has to; the `›` is the session marker, and its absence means "this is the
 * place, not a thread of it" (design-decisions §3, BC-23).
 *
 * **The budget is CSS, not JavaScript.** A measured layout would need a
 * ResizeObserver per row and would re-run on every sidebar width change; a
 * declarative one is deterministic, free, and assertable from computed style in
 * a browser test (BC-25). The rules are constants here rather than literals at
 * the call site so the three spans cannot drift apart.
 *
 * @module shared/lib/row-grammar
 */

/**
 * The mark between an agent's name and the session's title.
 *
 * Not a hyphen and not a middot: `›` reads as descent — this thing is *inside*
 * that one — which is exactly the relationship a session has to the agent that
 * owns it.
 */
export const ROW_SESSION_MARKER = '›';

/**
 * The agent-name span: capped at 42% of the text line, then ellipsis.
 *
 * A cap rather than a share. The name is the stable scan anchor — the same
 * agent with three sessions makes three rows and the repetition is the point —
 * but a long name must never be allowed to eat the title that tells the two
 * apart.
 */
export const ROW_WHO_CLASS = 'max-w-[42%] shrink-0 truncate';

/** The title span: takes what is left, never below ~6 characters. */
export const ROW_TITLE_CLASS = 'min-w-[6ch] flex-auto truncate';

/**
 * The trailing meta slot: never pushed off, never shrunk.
 *
 * A timestamp, an unread badge, an origin mark and a project chip are all
 * facts you read at a glance without meaning to. A budget that let them be
 * squeezed would be a budget that hides them exactly when the row is busiest.
 */
export const ROW_TRAILING_CLASS = 'flex-none';

/**
 * The whole row in one line — the row's `title` attribute and its tooltip.
 *
 * The visible line truncates; this does not. A person who cannot tell two rows
 * apart at a glance can always hover one and be told.
 *
 * @param who - The agent a session belongs to, or `null` for a row that is a
 *   place rather than a thread of one.
 * @param title - What the row is called.
 */
export function composeRowLabel(who: string | null | undefined, title: string): string {
  const trimmedWho = who?.trim();
  if (!trimmedWho) return title;
  return `${trimmedWho} ${ROW_SESSION_MARKER} ${title}`;
}

/**
 * Whether a row earns its second line.
 *
 * Height differences carry meaning, so a row only grows when there is something
 * live to say (a verb) or something worth reading (a preview). Everything else
 * stays one line, and a quiet sidebar stays quiet (BC-24).
 *
 * @param row - Whether the row reserves a verb line, and what preview it has.
 */
export function hasSecondLine(row: {
  reservesVerbLine?: boolean;
  preview?: string | null;
}): boolean {
  return row.reservesVerbLine === true || (row.preview ?? '').trim().length > 0;
}
