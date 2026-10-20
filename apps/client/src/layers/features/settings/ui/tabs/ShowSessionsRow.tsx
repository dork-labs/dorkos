/**
 * The Show sessions switch (DOR-3074): whether the working session behind a
 * chat can be opened from the chat's header.
 *
 * @module features/settings/ui/tabs/ShowSessionsRow
 */
import { SwitchSettingRow } from '@/layers/shared/ui';
import { useDmViewEnabled, useShowSessions, useUpdateShowSessions } from '@/layers/entities/config';

/**
 * One switch row, drawn only while chats with one agent read like a DM.
 *
 * Without that view the session IS the chat, so a switch to reveal it would
 * change nothing, and a control that changes nothing is not drawn. The row
 * outlives the experiment: it is a setting for everyone using this DorkOS, not
 * a trial.
 */
export function ShowSessionsRow() {
  const dmView = useDmViewEnabled();
  const showSessions = useShowSessions();
  const { setShowSessions } = useUpdateShowSessions();

  if (!dmView) return null;
  return (
    <SwitchSettingRow
      label="Show sessions"
      description="See the working session behind each chat: model, account and context."
      checked={showSessions}
      onCheckedChange={setShowSessions}
    />
  );
}
