/**
 * What a permission mode means, for every surface that has to say so.
 *
 * ## Why this is in `shared` and not next to the session entity
 *
 * A permission mode is chosen in three unrelated places — the session status
 * line, a channel binding, and a scheduled task — and each of them owes the
 * person the same sentence about what the mode does and does not cover. Two of
 * those live in `features`, one in `entities/binding`, and an entity may not
 * import a sibling entity. So a definition parked in `entities/session` is
 * reachable by two of the three, which is exactly how one surface ends up warning
 * and another looking ordinary about the same setting.
 *
 * `shared` is the only layer all three can see. That is the whole reason it moved
 * here, and the reason it should not move back.
 *
 * @module shared/lib/permission-mode
 */

/**
 * Permission modes that hand the agent the keys — it runs every tool without
 * asking. `always-allow` is the test-mode runtime's spelling of the same thing;
 * modes arrive as loose strings from runtime capability profiles, so this takes
 * a string rather than the `PermissionMode` union.
 */
const BYPASS_PERMISSION_MODES = new Set<string>(['bypassPermissions', 'always-allow']);

/**
 * Whether a permission mode means the agent acts without asking. The ONE
 * definition of that fact — the standing banner, the status line's severity
 * ranking, the scope note next to every mode picker, and anything else that
 * warns about it must agree, or a session can warn on one surface and look
 * ordinary on another (DOR-482, DOR-463, DOR-501).
 *
 * @param mode - The session's effective permission mode, if known.
 */
export function isBypassPermissionMode(mode: string | null | undefined): boolean {
  return mode != null && BYPASS_PERMISSION_MODES.has(mode);
}
