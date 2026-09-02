/**
 * Who wrote the display name that is stored right now, and the one rule that
 * decides it (DOR-1022).
 *
 * ## The problem this closes
 *
 * `config.profile.displayName` is `agent-writable` on purpose and stays that
 * way: DorkBot saving "call me Dorian" mid-conversation IS the onboarding flow,
 * and flipping the field operator-only would break it (the write policy's own
 * entry says so, and DOR-979 adjudicated it twice). What was missing is the
 * other half. Since DOR-979 that name is also the roster's name and the account
 * menu's name, and since DOR-899 it rides bridged posts — so a suggestion an
 * agent made silently became what every surface calls the person, with nothing
 * anywhere saying it was not theirs.
 *
 * So the name stays writable and the WRITE gets recorded. A surface can then say
 * "Suggested by DorkBot" until the person saves a name themselves.
 *
 * ## The rule, and why each half of it is the way it is
 *
 * - **A person writing the name always stamps `operator`, even when the value
 *   does not change.** Re-saving the name already in the field is exactly how a
 *   person says "yes, that one is mine", and it is the gesture the hint asks
 *   for. Anything else would leave somebody unable to dismiss it.
 * - **An agent writing the SAME value changes nothing.** DorkBot re-sending a
 *   name the person already confirmed is not a new suggestion, and stamping it
 *   would raise the hint on a name they chose — a false alarm on the one surface
 *   this feature exists to keep honest.
 * - **Clearing the name clears the record.** There is no provenance for a value
 *   that is gone, and a stale `agent` stamp beside a `null` name would draw a
 *   hint under the roster's `You` fallback.
 *
 * ## What this module does NOT know
 *
 * Whether the caller really is a person. It is told, by the door that received
 * the write. Two of the three doors that reach {@link stampDisplayNameSource}
 * are general-purpose (`PATCH /api/config`, `dorkos config set`) and both say
 * `operator`, which inherits the residual `caller-authority.ts` already
 * documents: with local login off, this machine cannot tell the person in the
 * app from any other process running as them, so an agent willing to bypass its
 * own tool surface and `curl` the config route would be read as a person here.
 * That is the accepted posture rather than a gap this module can close — the
 * hint is a signal about a name, not a control over one — and the agent-facing
 * door, which is the one an agent actually has, is `config_patch` and stamps
 * `agent`. The record leaf itself is `operator-only`, so no patch can write it
 * directly whichever door it arrives at.
 *
 * @module services/identity/display-name-provenance
 */
import type { DisplayNameSource } from '@dorkos/shared/config-schema';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';

/**
 * Who is making a write that carries a display name.
 *
 * A fact the DOOR supplies, never one inferred from the patch: the same merged
 * object arrives at the person's settings route and at the agent's tool, and
 * nothing in it distinguishes them.
 */
export type DisplayNameWriter =
  | {
      /** A person, at one of their own surfaces. */
      kind: 'operator';
    }
  | {
      /** An agent, through the `config_patch` capability. */
      kind: 'agent';
      /**
       * The writing agent's own name, or `null` when this install could not
       * resolve an identity for the caller.
       *
       * Best-effort by design: an agent whose identity token has expired or was
       * never minted still wrote the name, and a hint that vanished in that case
       * would be silent exactly where attribution is weakest. Surfaces say "an
       * agent" instead of inventing one.
       */
      agentName: string | null;
    };

/**
 * The provenance to store after a write that carries a display name.
 *
 * Pure: it decides, it never writes. The caller persists the answer alongside
 * the name in whatever way its own door already writes config, which is what
 * lets the three doors share one rule without sharing a store.
 *
 * @param before - The display name stored before this write, or `null`.
 * @param after - The display name this write lands, or `null` to clear it.
 * @param writer - Who is making the write.
 * @returns The value for `profile.displayNameSource`, or `undefined` when this
 *   write is not a reason to touch the record at all.
 */
export function stampDisplayNameSource(
  before: string | null,
  after: string | null,
  writer: DisplayNameWriter
): DisplayNameSource | null | undefined {
  // No name, no provenance — and this runs before the writer is consulted, so
  // an agent clearing a name cannot leave its own stamp behind either.
  if (after === null) return null;

  if (writer.kind === 'operator') return { kind: 'operator' };

  // An agent re-affirming what is already stored is not a suggestion. Compared
  // trimmed, because the schema trims what it stores and a patch carrying the
  // same name with a stray space is the same name.
  if (before !== null && before.trim() === after.trim()) return undefined;

  return {
    kind: 'agent',
    // Sanitized here rather than at the surface that draws it, for the reason
    // `resolveAnswererName` states about the two name rungs it reads: this
    // string is written by an agent and printed inside a sentence DorkOS wrote.
    // A name that sanitizes away to nothing is not a name, so it falls back to
    // the same `null` an unresolvable identity produces.
    agentName: writer.agentName ? (sanitizeIdentity(writer.agentName) ?? null) : null,
  };
}
