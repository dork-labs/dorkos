import { useCallback, useState } from 'react';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';

/** What {@link useRemoteAccessSwitch} hands the Remote Access tab. */
export interface RemoteAccessSwitchModel {
  /** Whether remote access is on, or `undefined` until the config is read. An older server that sends no switch reads as on. */
  enabled: boolean | undefined;
  /** A change is on its way to the server. */
  busy: boolean;
  /** Why the last change was refused, in the server's words. */
  error: string | null;
  /** Turn remote access on or off; resolves `true` when the server took it. */
  setEnabled: (enabled: boolean) => Promise<boolean>;
}

/**
 * The Remote Access switch (DOR-3650): read `remoteAccess.enabled` from the
 * config and write it back through `PATCH /api/config`. Turning it on is a
 * person's setting at this computer; the server refuses anyone else, and the
 * refusal shows here in its own words.
 */
export function useRemoteAccessSwitch(): RemoteAccessSwitchModel {
  const { data: config } = useConfig();
  const update = useUpdateConfig();
  const [error, setError] = useState<string | null>(null);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      setError(null);
      try {
        await update.mutateAsync({ remoteAccess: { enabled } });
        return true;
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : 'Could not change that.');
        return false;
      }
    },
    [update]
  );

  return {
    enabled: config ? (config.remoteAccess?.enabled ?? true) : undefined,
    busy: update.isPending,
    error,
    setEnabled,
  };
}
