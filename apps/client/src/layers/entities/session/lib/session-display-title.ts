/** Fallback label for a session that has not derived a title yet. */
export const UNTITLED_SESSION_LABEL = 'Untitled session';

/**
 * A session's human-readable title, never blank (DOR-202).
 *
 * A session's `title` is `''` (not undefined) until its first message derives
 * one, so `?? 'Untitled'`-style fallbacks silently render nothing. Every
 * surface that displays a session title should route through this helper.
 *
 * @param title - The session's raw title (may be empty)
 */
export function sessionDisplayTitle(title: string): string {
  return title === '' ? UNTITLED_SESSION_LABEL : title;
}
