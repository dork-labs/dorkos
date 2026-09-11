/**
 * Your roles: what kind of work you do, so DorkBot and your other agents know
 * who they work for (spec `user-profile-onboarding`; FB-11 / DOR-1972).
 *
 * The same {@link ProfileRolePicker} the onboarding role beat and the
 * existing-user `ProfilePromptCard` use, reached through the onboarding
 * feature's public barrel (the sanctioned door for a sibling feature's model,
 * per `.claude/rules/fsd-layers.md`) — so picking a role here saves through the
 * same `profile.roles` write path and looks identical everywhere it is asked.
 * Before this field existed, Settings › Profile edited your photo, name,
 * handle and email but never the one answer the onboarding prompt asks for —
 * the prompt could point here, but there was nothing to find (DOR-1972).
 *
 * @module features/profile/ui/fields/ProfileRolesField
 */
import { useState } from 'react';
import { ProfileRolePicker, useProfile } from '@/layers/features/onboarding';
import { FieldCard, FieldCardContent, SettingRow } from '@/layers/shared/ui';
import { FieldNote } from './ProfileFields';

/** Whether two role lists hold the same entries, order aside. */
function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((role) => bSet.has(role));
}

/**
 * Your kind of work, editable any time — not just at first run.
 *
 * Follows the same shape as the other fields in `ProfileFields`: a local draft
 * seeded from the server, reseeded only when the stored value genuinely moves
 * out from under it (a save from elsewhere), with "Saved" tracked against what
 * was actually sent rather than against the seed — so a reseed that lands on
 * exactly what was just saved (the normal case, right after a successful save)
 * does not blank the confirmation out from under it.
 */
export function ProfileRolesField() {
  const { roles: storedRoles, isLoading, saveRoles } = useProfile();
  const [selected, setSelected] = useState<string[]>(storedRoles);
  const [seed, setSeed] = useState<string[]>(storedRoles);
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [lastSaved, setLastSaved] = useState<string[] | null>(null);

  if (!isLoading && !sameRoles(seed, storedRoles)) {
    setSeed(storedRoles);
    setSelected(storedRoles);
  }

  const handleSave = () => {
    setStatus('saving');
    saveRoles(selected)
      .then(() => {
        setStatus('idle');
        setLastSaved(selected);
      })
      .catch(() => setStatus('error'));
  };

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <SettingRow
          label="What kind of work you do"
          description="Read only by DorkBot and your other agents, on this machine. Nobody else sees it."
          orientation="vertical"
        >
          <ProfileRolePicker
            selected={selected}
            onChange={setSelected}
            onConfirm={handleSave}
            confirmLabel={status === 'saving' ? 'Saving…' : 'Save'}
            busy={status === 'saving' || isLoading}
          />
        </SettingRow>
        {status === 'error' && <FieldNote tone="error">Could not save that. Try again.</FieldNote>}
        {status !== 'error' && lastSaved && sameRoles(selected, lastSaved) && (
          <FieldNote tone="ok">Saved.</FieldNote>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}
