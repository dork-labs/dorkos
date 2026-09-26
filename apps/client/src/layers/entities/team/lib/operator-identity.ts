/**
 * What the operator is still missing to be addressable, and the one handle
 * DorkOS may OFFER them (DOR-677, spec `handles` §4).
 *
 * Pure, and in the entity because two features ask: onboarding decides from it
 * whether to put the question at all, and the profile form uses the suggestion
 * as the value it shows before anything is saved.
 *
 * @module entities/team/lib/operator-identity
 */
import { deriveHandle } from '@dorkos/shared/handle';
import { OPERATOR_FALLBACK_DISPLAY_NAME, type TeamMember } from '@dorkos/shared/team-schemas';

/** Whether the operator has chosen a name, and whether they have a handle. */
export interface OperatorIdentityGaps {
  /** No name beyond the `You` placeholder the roster falls back to. */
  name: boolean;
  /** No `@handle`, so nobody can mention them. */
  handle: boolean;
}

/**
 * Which half of the operator's identity is still missing.
 *
 * `You` counts as missing because nobody chose it: it is what the roster says
 * when this install knows no other name (`operator-profile.ts`).
 *
 * @param self - The operator's own roster row.
 */
export function operatorIdentityGaps(self: TeamMember): OperatorIdentityGaps {
  return {
    name: self.displayName.trim() === '' || self.displayName === OPERATOR_FALLBACK_DISPLAY_NAME,
    handle: !self.handle,
  };
}

/**
 * Whether the operator is missing a name or a handle.
 *
 * @param self - The operator's own roster row.
 */
export function isOperatorIdentityIncomplete(self: TeamMember): boolean {
  const gaps = operatorIdentityGaps(self);
  return gaps.name || gaps.handle;
}

/**
 * The handle to show in the field before the person has typed one, or `''`.
 *
 * **Only from an email the person signed in with**, and only as a starting
 * value they see and can change before it is saved. With no email there is
 * nothing honest to derive from — the OS username is personal data and `you` is
 * the defect itself — so the field starts empty (spec `handles` §4). Nothing
 * here writes anything: absence is never consent (DOR-604).
 *
 * De-collided against every handle the roster already shows, so the value
 * offered is one this install can accept. A handle released by somebody else
 * is invisible from here; the server refuses that one by name, and the form
 * says so.
 *
 * @param self - The operator's own roster row.
 * @param roster - Every row on the roster, for the handles already taken.
 */
export function suggestOperatorHandle(self: TeamMember, roster: readonly TeamMember[]): string {
  const localpart = self.person?.email?.split('@')[0]?.trim();
  if (!localpart) return '';
  const taken = new Set(
    roster
      .filter((member) => member.id !== self.id && member.handle)
      .map((member) => member.handle!.toLowerCase())
  );
  return deriveHandle(localpart, taken) ?? '';
}
