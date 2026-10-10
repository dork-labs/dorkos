/**
 * Fallback label for a session that has not derived a title yet.
 *
 * "New session" rather than "Untitled session": the state it names is a
 * conversation that has not happened yet, not one that failed to get a name.
 * The header, the sidebar rows, the switcher and ⌘K all read it from here, so
 * there is one word for one state — the alternative, which this replaced, was
 * a bar and a list calling the same session two different things.
 */
export const UNTITLED_SESSION_LABEL = 'New chat';

/**
 * A session's human-readable title, never blank (DOR-202).
 *
 * A session's `title` is `''` (not undefined) until its first message derives
 * one, so `?? 'Untitled'`-style fallbacks silently render nothing. Every
 * surface that displays a session title should route through this helper.
 *
 * Whitespace counts as empty. A title of `'   '` is not a name a person chose;
 * it renders as a blank gap wherever the raw string reaches the DOM, and it
 * used to survive an `=== ''` check — so the emptiness test lives here, once,
 * rather than at each call site deciding for itself.
 *
 * Missing counts as empty too. A row written from a settings reply, before the
 * chat exists on the server, carries no `title` at all, and a surface reading
 * the shared cache must not crash on it (DOR-2820: the window title did).
 *
 * @param title - The session's raw title (may be empty, whitespace or missing)
 */
export function sessionDisplayTitle(title: string | null | undefined): string {
  return !title || title.trim() === '' ? UNTITLED_SESSION_LABEL : title;
}
