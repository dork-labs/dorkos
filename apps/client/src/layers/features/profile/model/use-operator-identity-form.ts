/**
 * The name-and-handle question as one form (DOR-677): the drafts, what they
 * start as, and one save that writes each half through the route that already
 * owns it.
 *
 * **Not a second editor.** Settings › Profile edits the name and the handle as
 * two cards that save separately, which is right for a person changing one of
 * them. The question onboarding puts is different — "who are you?" answered
 * once — so it gets one confirm. Everything beneath the confirm is shared: the
 * same two mutations (`useUpdateProfileName`, and `useSetAuthorHandle` over
 * `PATCH /api/rooms/authors/:id/handle`, the handles spec's one route), the
 * same server-side grammar, tombstones and uniqueness, and the same refusal
 * sentences (`handleErrorMessage`, `nameErrorMessage`).
 *
 * @module features/profile/model/use-operator-identity-form
 */
import { useState } from 'react';
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import { nameProvenanceNote, suggestOperatorHandle, useTeamRoster } from '@/layers/entities/team';
import { handleErrorMessage, nameErrorMessage } from './profile-errors';
import { useMountedRef } from './use-mounted-ref';
import { useSetAuthorHandle, useUpdateProfileName } from './use-profile-edits';
import { useServerSeededDraft } from './use-server-seeded-draft';

/** What {@link useOperatorIdentityForm} hands the form. */
export interface OperatorIdentityFormApi {
  /** Whether the operator's own roster row has loaded — nothing can be saved before. */
  ready: boolean;
  /** The name draft. */
  name: string;
  /** Replace the name draft. */
  setName: (next: string) => void;
  /** The handle draft. */
  handle: string;
  /** Replace the handle draft. */
  setHandle: (next: string) => void;
  /** Whether the confirm button should be live. */
  canSave: boolean;
  /** Whether a save is in flight. */
  saving: boolean;
  /** Why the name was refused, or `null`. */
  nameError: string | null;
  /**
   * "Suggested by DorkBot" while the name in the field is one an agent chose
   * and nobody has saved since (DOR-1022), else `null`. Confirming it is how
   * the person makes it theirs.
   */
  nameSuggestion: string | null;
  /** Why the handle was refused, or `null`. */
  handleError: string | null;
  /**
   * Write whatever changed. Resolves `true` when nothing is left unsaved —
   * including when nothing had changed, which is how somebody says "yes, that
   * is me" to values that were already right. Resolves `false` after a refusal,
   * whose sentence is then in `nameError` / `handleError`. Never rejects.
   */
  save: () => Promise<boolean>;
}

/**
 * Drive the name-and-handle form for the person at the keyboard.
 *
 * The handle starts as the one already saved, else the suggestion from a
 * sign-in email (`suggestOperatorHandle`), else empty. That starting value is
 * only ever shown: nothing is written until the person presses the confirm.
 */
export function useOperatorIdentityForm(): OperatorIdentityFormApi {
  const roster = useTeamRoster();
  const members = roster.data?.members ?? [];
  const self = members.find((member) => member.isSelf);

  // Refusals are drawn under the fields, so the shared toast stays out of
  // them — only while this form is on screen. A save that fails after the row
  // collapsed or the card was dismissed toasts, or it is shown nowhere.
  const mounted = useMountedRef();
  const updateName = useUpdateProfileName({ isShownInline: () => mounted.current });
  const setAuthorHandle = useSetAuthorHandle({ isShownInline: () => mounted.current });
  const [saving, setSaving] = useState(false);

  // `You` is a placeholder nobody chose, so it seeds an empty field (the same
  // rule `ProfileNameField` follows) rather than a value one click could save.
  const storedName =
    !self || self.displayName === OPERATOR_FALLBACK_DISPLAY_NAME ? '' : self.displayName;
  const storedHandle = self?.handle ?? '';
  const [name, setName] = useServerSeededDraft(storedName);
  const [handle, setHandle] = useServerSeededDraft(
    self ? storedHandle || suggestOperatorHandle(self, members) : ''
  );

  const nextName = name.trim();
  const nextHandle = handle.trim();
  // An agent's suggestion is re-saved even unchanged: that save is what
  // records the person as its author and clears the note, exactly as pressing
  // Save on the same name does in Settings (DOR-1022).
  const suggestedBy = self ? nameProvenanceNote(self) : null;
  const nameNeedsWrite = nextName.length > 0 && (nextName !== storedName || suggestedBy !== null);

  // A refusal is shown only while the field still holds what was refused, for
  // the reason `FieldNote` gives about "Saved": typing is the person acting on
  // it, and a sentence about a value no longer in the field is stale.
  const nameError =
    updateName.isError && updateName.variables === nextName
      ? nameErrorMessage(updateName.error)
      : null;
  const handleError =
    setAuthorHandle.isError && setAuthorHandle.variables?.handle === nextHandle
      ? handleErrorMessage(setAuthorHandle.error, nextHandle)
      : null;

  const save = async (): Promise<boolean> => {
    if (!self) return false;
    setSaving(true);
    let ok = true;
    // One after the other, and each on its own: a taken handle must not cost
    // the person the name they typed, and a retry re-sends only what is still
    // different from what is stored.
    if (nameNeedsWrite) {
      ok = await updateName.mutateAsync(nextName).then(
        () => ok,
        () => false
      );
    }
    if (nextHandle && nextHandle !== storedHandle) {
      ok = await setAuthorHandle.mutateAsync({ authorId: self.id, handle: nextHandle }).then(
        () => ok,
        () => false
      );
    }
    setSaving(false);
    return ok;
  };

  return {
    ready: self !== undefined,
    name,
    setName,
    handle,
    setHandle,
    canSave: self !== undefined && !saving && (nextName.length > 0 || nextHandle.length > 0),
    saving,
    nameError,
    nameSuggestion: suggestedBy !== null && nextName === storedName ? suggestedBy : null,
    handleError,
    save,
  };
}
