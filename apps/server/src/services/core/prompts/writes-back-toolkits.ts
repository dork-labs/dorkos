/**
 * The one list of apps the writes-back switch is offered for (DOR-4794, Security Must 1). Read by
 * the store (which refuses the switch, and reads it as off, for any other app) and again by
 * `should-ask.ts` (which asks for any other app whatever the switch says), so one list decides both.
 *
 * @module services/core/prompts/writes-back-toolkits
 */

/**
 * The apps whose every `write` stays inside the team's own workspace, so writing back to them
 * can't carry anyone's words to anybody new. Mail, chat and calendar apps are left off on purpose:
 * their writes are sends, and a send must always ask. Server-only; adding an app here is a
 * security decision, reviewed like any other.
 */
export const WRITES_BACK_TOOLKITS: ReadonlySet<string> = new Set(['linear']);

/**
 * Whether the writes-back switch is offered for an app.
 *
 * @param toolkit - The app's toolkit id, e.g. `linear`; absent never is.
 */
export function writesBackSupported(toolkit: string | undefined): boolean {
  return toolkit !== undefined && WRITES_BACK_TOOLKITS.has(toolkit.toLowerCase());
}
