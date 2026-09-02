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
 * ## Three doors, and what each of them may claim
 *
 * There are exactly three ways a display name is written, and they do not have
 * equal standing. Only one can prove a person is behind it.
 *
 * | Door | May claim | Why |
 * | --- | --- | --- |
 * | `PATCH /api/profile` | `operator` | The only door that REFUSES an agent (`operatorOrRefuse` plus the ownership check). A save here is a person's, so it is the one gesture that dismisses the hint — {@link OPERATOR_SAVE_SOURCE}. |
 * | `config_patch` | `agent` | The agent-facing capability. It knows an agent asked and usually which one. |
 * | `PATCH /api/config`, `dorkos config set` | nothing — `unattributed` | General-purpose doors that cannot tell who is calling. |
 *
 * **That third row is a decision, not an omission.** These doors used to stamp
 * `operator`, on the argument that the app and the terminal ARE the person.
 * With local login off — the default (ADR-0320) — the server cannot tell the app
 * from any other process running as the same user (`caller-authority.ts`), so an
 * agent that skipped its own tool surface and `curl`ed `PATCH /api/config` was
 * read as a person: it could re-send its OWN suggestion through that door and
 * launder its stamp into `operator`, erasing the note it had raised. A signal
 * anyone can clear about themselves is not a signal.
 *
 * So an unattributed door says only what it can prove. Re-sending the value
 * already stored changes nothing at all (the laundering attempt is a no-op, and
 * the agent's stamp survives it). Writing a DIFFERENT name records `null` — "no
 * record" — which draws no hint and, just as importantly, attributes the write
 * to nobody. The person's route is still one click away and still definitive.
 *
 * ## The rest of the rule
 *
 * - **A person's save stamps `operator` even when the value does not change.**
 *   Re-saving the name already in the field is exactly how somebody says "yes,
 *   that one is mine". Anything else would leave a person who LIKES the agent's
 *   suggestion unable to dismiss the note about it.
 * - **A writer re-sending the SAME value changes nothing.** For an agent that is
 *   a false-alarm guard (DorkBot re-sending a name the person confirmed is not a
 *   new suggestion); for an unattributed door it is the anti-laundering rule
 *   above. One line serves both because it is the same fact: a write that moves
 *   nothing has said nothing about who chose the value.
 * - **Clearing the name clears the record.** There is no provenance for a value
 *   that is gone, and a stale `agent` stamp beside a `null` name would draw a
 *   hint under the roster's `You` fallback.
 *
 * The record leaf itself is `operator-only` in `CONFIG_WRITE_POLICY`, so no
 * patch can write or clear it directly at any of the three doors — every value
 * it ever holds is derived here or is {@link OPERATOR_SAVE_SOURCE}.
 *
 * @module services/identity/display-name-provenance
 */
import type { DisplayNameSource } from '@dorkos/shared/config-schema';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';

/**
 * The provenance a save through `PATCH /api/profile` records.
 *
 * A constant rather than a branch of {@link stampDisplayNameSource}, because it
 * depends on nothing: not on the value, not on what was stored before. That
 * route is the only door that refuses an agent, so a save arriving there IS the
 * person, and answering `operator` unconditionally is what makes the note
 * dismissable by somebody who is happy with the name an agent picked.
 *
 * Exported from this module so the whole rule — all three doors — is stated in
 * one place, and `routes/profile.ts` cites it rather than restating it.
 */
export const OPERATOR_SAVE_SOURCE: DisplayNameSource = Object.freeze({ kind: 'operator' });

/**
 * Who is making a write that arrives at a general config door.
 *
 * A fact the DOOR supplies, never one inferred from the patch: the same merged
 * object arrives at the agent's tool and at `PATCH /api/config`, and nothing in
 * it distinguishes them.
 *
 * There is deliberately no `operator` member. A door that could name a person is
 * `PATCH /api/profile`, which does not come through here at all — it uses
 * {@link OPERATOR_SAVE_SOURCE}. Leaving the option out is what stops a future
 * door from quietly claiming an authority it cannot check (see the module doc's
 * laundering note).
 */
export type DisplayNameWriter =
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
    }
  | {
      /**
       * A general config door — `PATCH /api/config` or `dorkos config set` —
       * which cannot say whether a person or a process is behind it.
       */
      kind: 'unattributed';
    };

/**
 * The provenance to store after a write that carries a display name.
 *
 * Pure: it decides, it never writes. The caller persists the answer alongside
 * the name in whatever way its own door already writes config, which is what
 * lets the doors share one rule without sharing a store.
 *
 * @param before - The display name stored before this write, or `null`.
 * @param after - The display name this write lands, or `null` to clear it.
 * @param writer - Which kind of door this write came through.
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

  // A write that moves nothing has said nothing about who chose the value. For
  // an agent that stops a redundant patch raising a note on a name the person
  // confirmed; for an unattributed door it stops the laundering attempt in the
  // module doc. Compared trimmed, because the schema trims what it stores and a
  // patch carrying the same name with a stray space is the same name.
  if (before !== null && before.trim() === after.trim()) return undefined;

  // An unattributed door changed the name and cannot say who did. `null` is the
  // honest record: no hint is drawn, and nobody is credited either.
  if (writer.kind === 'unattributed') return null;

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
