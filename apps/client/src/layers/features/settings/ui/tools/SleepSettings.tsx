/**
 * The Sleep card in Settings → Tools: whether this computer stays awake while
 * agents work (spec `keep-awake`).
 *
 * The switch shows the setting as the server reports it on the keep-awake
 * status, and writes `keepAwake.whileAgentsWork` through `PATCH /api/config`.
 * The server applies it at once, without a restart, and pushes the new status,
 * which is what moves the switch and the top-bar cup.
 *
 * On a computer that cannot be held awake (a container, no sleep control tool,
 * or a refusal) the switch is disabled and the one line says why.
 *
 * "Wake for scheduled tasks" is not offered here yet: the setting exists, but
 * nothing reads it until waking is built, and a switch that does nothing is
 * worse than no switch.
 *
 * @module features/settings/ui/tools/SleepSettings
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FieldCard, FieldCardContent, SwitchSettingRow } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import {
  KEEP_AWAKE_CAVEAT,
  KEEP_AWAKE_KEY,
  SLEEP_SETTINGS,
  UNSUPPORTED_COPY,
  useKeepAwake,
} from '@/layers/entities/keep-awake';

/** The Sleep card. Draws nothing until the status has loaded. */
export function SleepSettings() {
  const status = useKeepAwake();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const setWhileAgentsWork = useCallback(
    async (whileAgentsWork: boolean) => {
      // The one key it changes: `PATCH /api/config` deep-merges.
      await transport.updateConfig({ keepAwake: { whileAgentsWork } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...KEEP_AWAKE_KEY] }),
        queryClient.invalidateQueries({ queryKey: configKeys.all }),
      ]);
    },
    [transport, queryClient]
  );

  if (!status) return null;
  const unsupported = status.supported ? null : UNSUPPORTED_COPY[status.reason ?? 'platform'];

  return (
    <div className="space-y-2" data-section={SLEEP_SETTINGS.section}>
      <p className="text-sm font-medium">Sleep</p>
      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Keep this computer awake while agents work"
            description={
              <span className="flex flex-col gap-1">
                <span>Stays awake during chats, rooms and tasks. Sleeps as usual when idle.</span>
                <span data-testid="sleep-settings-note">{unsupported ?? KEEP_AWAKE_CAVEAT}</span>
              </span>
            }
            checked={status.enabled}
            onCheckedChange={(next) => void setWhileAgentsWork(next)}
            disabled={unsupported !== null}
          />
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
