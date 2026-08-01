/**
 * The one question both autonomy doors ask: has this person been told what Full
 * autonomy means, and did they say yes to THIS?
 *
 * There are two doors, and they guard different things (spec `trust-dial`,
 * decisions 5 and 6):
 *
 * - `PATCH /api/sessions/:id` — putting ONE session into a Full-autonomy mode.
 * - `PATCH /api/config` — making Full autonomy the stop every NEW session starts
 *   at, globally or for one runtime.
 *
 * The second is the wider claim: it applies to sessions that do not exist yet, it
 * is durable, and a session born from it opens already bypassed with no dialog to
 * show. So it is gated at SET-time — the moment the person chooses it is the
 * moment they are told what it means, and the record they leave then is what
 * satisfies the first door for every session the default births. That is why both
 * doors read the same standing record through this module rather than each
 * keeping its own idea of what consent looks like.
 *
 * ## Why it lives beside the approvals
 *
 * Full autonomy is the setting that turns the approval gate off, so the record
 * of a person agreeing to that belongs with the code that runs the gate rather
 * than in a module of its own at the top of `services/core`.
 *
 * ## Still a consent ritual, not a security boundary
 *
 * Read `ui.autonomyAcknowledgedAt`'s own doc before building on this. The record
 * proves a person was shown a dialog; it proves nothing about who sent a request.
 * What keeps an AGENT away from the config door is a different mechanism
 * entirely — the four `defaultTrustStop` leaves are `operator-only` in
 * {@link CONFIG_WRITE_POLICY} — and this gate sits on top of that, for the person
 * who does have the right to change it.
 *
 * @module services/core/approvals/autonomy-consent
 */
import { configManager } from '../config-manager.js';

/**
 * The refusal code both doors answer with. One code, because a caller's recovery
 * is identical either way: show the person what Full autonomy means, get their
 * acknowledgement, retry the identical request.
 */
export const AUTONOMY_ACK_REQUIRED_CODE = 'AUTONOMY_ACK_REQUIRED';

/**
 * The config leaves that decide where a NEW session starts, in the order the
 * settings card reads them. Writing `'autonomy'` into any of them is what this
 * module gates.
 */
const DEFAULT_TRUST_STOP_PATHS = [
  'runtimes.defaultTrustStop',
  'runtimes.claudeCode.defaultTrustStop',
  'runtimes.codex.defaultTrustStop',
  'runtimes.opencode.defaultTrustStop',
] as const;

/** Narrow an unknown to a plain object without asserting a shape. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a dot-path out of a raw patch, tolerating every shape a caller can send. */
function readPath(patch: unknown, path: string): unknown {
  let current: unknown = patch;
  for (const key of path.split('.')) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

/**
 * Whether this person has a standing acknowledgement of what Full autonomy means
 * on file (`ui.autonomyAcknowledgedAt`).
 *
 * Read fresh on every call rather than cached: clearing it in Settings has to
 * bring the dialog back on the very next change, not after a restart. The `?.` is
 * for the pre-boot window every other `configManager` reader documents — no
 * config manager means no record, which is the direction that keeps asking.
 */
export function hasStandingAutonomyAck(): boolean {
  const ui = configManager?.get('ui') as { autonomyAcknowledgedAt?: string | null } | undefined;
  return typeof ui?.autonomyAcknowledgedAt === 'string' && ui.autonomyAcknowledgedAt.length > 0;
}

/**
 * Whether a config patch RECORDS the acknowledgement in the same write.
 *
 * This is what makes set-time consent one atomic action: the Settings dialog
 * writes the record and the new default together, so there is no window where the
 * stop landed without the consent, and no two-request ordering for a client to
 * get wrong. A patch that only clears the record (`null`) does not count, which
 * is the same read {@link hasStandingAutonomyAck} applies to the stored value.
 *
 * @param patch - The raw patch body.
 */
function patchRecordsAutonomyAck(patch: unknown): boolean {
  const value = readPath(patch, 'ui.autonomyAcknowledgedAt');
  return typeof value === 'string' && value.length > 0;
}

/**
 * Find the default-trust-stop leaves a patch tries to set to Full autonomy
 * without consent — the config door's refusal list.
 *
 * Empty means the patch may proceed, which covers the three cases that are all
 * the same case: it sets no trust stop, it sets one below autonomy, or the
 * person's acknowledgement is already on file (or arrives in this very patch).
 *
 * Deliberately value-shaped rather than path-shaped. Every stop on the dial is
 * the same leaf, and only one of them is the choice a person cannot walk back —
 * gating the path instead would put a consent dialog in front of "ask me first",
 * which teaches people to click through the one that matters.
 *
 * @param patch - The raw patch a caller supplied (any shape; a non-object touches
 *   nothing).
 * @returns The offending config paths, in schema order. Empty when the write may
 *   go through.
 */
export function findUnacknowledgedAutonomyDefaults(patch: unknown): string[] {
  const asking = DEFAULT_TRUST_STOP_PATHS.filter(
    (path) => readPath(patch, path) === 'autonomy'
  ) as string[];
  if (asking.length === 0) return [];
  if (hasStandingAutonomyAck() || patchRecordsAutonomyAck(patch)) return [];
  return asking;
}

/**
 * What a caller refused by the config door is told. Written for a person's
 * screen first — the cockpit shows the consent dialog and retries — and readable
 * by anything else that gets here.
 */
export const AUTONOMY_DEFAULT_ACK_MESSAGE =
  'Starting every new session in Full autonomy needs you to confirm what it means first.';
