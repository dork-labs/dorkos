/**
 * The DM view switch (DOR-3074): the way back to chats that read like sessions.
 *
 * @module features/settings/ui/tabs/DmViewRow
 */
import { SwitchSettingRow } from '@/layers/shared/ui';
import { useDmViewEnabled, useUpdateDmView } from '@/layers/entities/config';

/** One switch row, always drawn: it graduated, so it is on by default, not a trial. */
export function DmViewRow() {
  const dmView = useDmViewEnabled();
  const { setDmView } = useUpdateDmView();

  return (
    <SwitchSettingRow
      label="Chats with one agent read like a DM"
      description="Talk to an agent like a teammate. Every door to it opens the same chat."
      checked={dmView}
      onCheckedChange={setDmView}
    />
  );
}
