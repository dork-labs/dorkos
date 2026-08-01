/**
 * What a permission mode means, for every surface that has to say so.
 *
 * ## Why this is in `shared` and not next to the session entity
 *
 * A permission mode is chosen in three unrelated places — the session status
 * line, an integration binding, and a scheduled task — and each of them owes the
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
 * Whether a permission mode means the agent acts without asking, answered from
 * the mode's NAME.
 *
 * ## This is the fallback, not the answer
 *
 * `isBypassSemantics` in `@dorkos/shared/permission-semantics` is authoritative:
 * it reads what the runtime declared its mode does, so it is right about modes
 * this list has never heard of. Use it wherever a descriptor is in hand — the
 * status line, the banner, the mode picker, the scope note beside a picker.
 *
 * This one exists for the places that have no runtime profile to consult: a
 * collapsed session row in a rail of fifty, rendering before the capability map
 * arrives. A guess from the id is better there than nothing, and every id it
 * knows is a real mode of a shipped runtime — but it is a guess, and a mode a
 * new runtime invents will not be in it.
 *
 * @param mode - The session's effective permission mode, if known.
 */
export function isBypassPermissionMode(mode: string | null | undefined): boolean {
  return mode != null && BYPASS_PERMISSION_MODES.has(mode);
}

/**
 * What each of Claude's built-in permission modes is called, in the person's
 * words. Runtimes ship their own labels in their capability profiles, so this is
 * the answer for surfaces that have no profile to hand — a collapsed session
 * row, say — and the fallback for the mode picker when a profile is still
 * loading.
 */
const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  dontAsk: "Don't Ask",
  bypassPermissions: 'Bypass All',
  auto: 'Auto',
};

/**
 * The name of a permission mode. An id nobody has a label for is returned
 * as-is: a runtime's own spelling of its mode is still the true answer to "what
 * is this session doing?", where a friendly-looking stand-in would not be
 * (DOR-496).
 *
 * @param mode - The session's effective permission mode.
 */
export function permissionModeLabel(mode: string): string {
  return PERMISSION_MODE_LABELS[mode] ?? mode;
}
