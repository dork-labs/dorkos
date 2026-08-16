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
 * ## Why only this module stayed stop-shaped
 *
 * The SESSION door was widened on 2026-08-01 (DOR-816): it now asks first about
 * any mode that never asks and can do more than read, not just the autonomy stop
 * — Codex files such a mode at the MIDDLE stop. Nothing here moved with it, and
 * that is the design rather than an omission.
 *
 * The two doors read different axes. A session PATCH carries a runtime MODE, and
 * a runtime may put "never asks" wherever it likes. `defaultTrustStop` stores one
 * of the dial's three STOPS — a runtime-neutral value resolved through each
 * runtime's profile when a session is born — and only `'autonomy'` can mean "do
 * not ask" there. There is no default-able value for "Codex's middle stop", so
 * there is nothing extra for {@link findUnacknowledgedAutonomyDefaults} to catch
 * and nothing extra for {@link demoteAutonomyDefaultsOnAckClear} to demote.
 *
 * What follows from that pairing is worth stating plainly, because it looks like
 * a hole and is not: a person who sets the middle stop as their default, on a
 * runtime that never asks there, gets no dialog at set-time — the same stop is
 * gated on other runtimes by nothing, because on them it still asks. The
 * disclosure that covers it is Settings' living caption, which spells out the
 * per-runtime consequence of the selected stop in amber (spec `trust-dial`,
 * decisions 2A and 6).
 *
 * @module services/core/approvals/autonomy-consent
 */
import { configManager } from '../config-manager.js';

/**
 * The refusal code both doors answer with. One code, because a caller's recovery
 * is identical either way: show the person what Full autonomy means, get their
 * acknowledgement, retry the identical request.
 *
 * **Its VALUE is depended on as a string literal by two callers outside this
 * package**, and neither can import it: the cockpit (`ChatStatusSection.tsx`
 * compares `err.code`) and `dorkos config set` (`packages/cli`, which reaches
 * the server only through a specifier esbuild rewrites at bundle time). Both
 * decide what to show a person from it. `__tests__/autonomy-consent.test.ts`
 * pins the value for exactly that reason — renaming it is a user-visible change
 * in two places the compiler cannot see.
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

/**
 * Whether a patch CLEARS the acknowledgement — Settings' Reset button, and the
 * only way the record ever goes away.
 *
 * Absent is not cleared: a patch that says nothing about the record leaves it
 * exactly as it was. Only an explicit `null` (or an empty string, which
 * {@link hasStandingAutonomyAck} already reads as no record) counts.
 */
function patchClearsAutonomyAck(patch: unknown): boolean {
  const record = asRecord(asRecord(patch)?.ui);
  if (!record || !('autonomyAcknowledgedAt' in record)) return false;
  const value = record.autonomyAcknowledgedAt;
  return value === null || value === '';
}

/**
 * The demotion a Reset has to carry with it: every default-trust-stop leaf that
 * would still say `'autonomy'` afterwards, set back to `null`.
 *
 * ## Why clearing the record cannot leave the default standing
 *
 * The acknowledgement is not a dialog preference — for a standing autonomy
 * default it is the LICENCE (decision 6: "set-time is consent-time, and that
 * standing ack satisfies the server's autonomy requirement for every session the
 * default births"). Take the licence away and leave the default, and the product
 * is in a state nothing can justify: new sessions keep being born bypassed, with
 * no dialog anywhere, while the first mode change the cockpit sends for one of
 * them is refused 428 by the session door — the person is running without asking
 * AND cannot change it back without meeting a dialog they thought they had
 * turned back on.
 *
 * So Reset means what it says. It brings the asking back, and the setting whose
 * only justification was the answer it just erased goes with it. Settings says
 * so on the button, and the changelog and docs say so in words.
 *
 * ## Same write, deliberately
 *
 * Returned as a fragment for the caller to merge into the patch rather than
 * applied here, so the clear and the demotion reach `applyConfigPatch` as ONE
 * write. Two writes would leave a window — however brief — in which a session
 * could be born bypassed with no record on file, which is the exact state this
 * exists to make unreachable.
 *
 * ## Why the guarded step and not `applyConfigPatch`
 *
 * This runs in `operator/config-write.ts`, one layer above the merge, so it sits
 * beside the consent check it is the other half of — the demotion and the 428
 * are one policy and read as one. Every door reaches it there: the HTTP route,
 * `dorkos config set`, and the `config_patch` capability (which cannot actually
 * trigger it, since the agent surface refuses `ui.autonomyAcknowledgedAt`
 * outright as `operator-only`).
 *
 * Below that line, `applyConfigPatch` answers only "is this a valid config",
 * which is what keeps it reusable and keeps this rule from being something a
 * future caller could reach around by picking a different entry point.
 *
 * @param patch - The raw patch body.
 * @param runtimes - The stored `runtimes` section; defaults to the live config.
 * @returns A `{ runtimes: … }` fragment to merge ON TOP of the patch, or `null`
 *   when the patch is not a Reset or no default is standing at autonomy.
 */
export function demoteAutonomyDefaultsOnAckClear(
  patch: unknown,
  runtimes?: unknown
): Record<string, unknown> | null {
  if (!patchClearsAutonomyAck(patch)) return null;
  const stored = { runtimes: runtimes ?? configManager?.get('runtimes') };

  const demoted: Record<string, unknown> = {};
  for (const path of DEFAULT_TRUST_STOP_PATHS) {
    // What the leaf would hold once this patch landed: the patch's own value
    // where it carries one, the stored value otherwise. A patch that both
    // clears the record and asks for autonomy is answered here rather than
    // argued with — the clear wins, and the stop lands at `null`.
    const fromPatch = readPath(patch, path);
    const effective = fromPatch !== undefined ? fromPatch : readPath(stored, path);
    if (effective !== 'autonomy') continue;
    // `runtimes.claudeCode.defaultTrustStop` → `{ claudeCode: { defaultTrustStop: null } }`
    const [, ...rest] = path.split('.');
    const leaf = rest.pop()!;
    const target = rest.reduce<Record<string, unknown>>((node, key) => {
      node[key] ??= {};
      return node[key] as Record<string, unknown>;
    }, demoted);
    target[leaf] = null;
  }

  return Object.keys(demoted).length > 0 ? { runtimes: demoted } : null;
}
