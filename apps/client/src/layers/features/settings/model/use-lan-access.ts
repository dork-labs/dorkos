import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LanAccessStatus } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { requestOwnerSetup } from '@/layers/shared/lib';
import { configKeys } from '@/layers/entities/config';

/** Query key for the Wi-Fi access status. */
export const lanAccessKey = ['lan-access'] as const;

/**
 * How often the status is reread while Settings shows it. The address changes
 * when the computer joins another network, and login can be turned off from
 * another tab, which turns Wi-Fi access off with it.
 */
const REFRESH_MS = 15_000;

/** What {@link useLanAccess} hands the Wi-Fi access card. */
export interface LanAccessModel {
  /** The status, or `undefined` while the first read is in flight. */
  status: LanAccessStatus | undefined;
  /** A switch is on its way to the server. */
  busy: boolean;
  /** Why the last switch was refused, in the server's words. */
  error: string | null;
  /** Flip the switch. Turning it on with login off walks into owner setup first. */
  setEnabled: (enabled: boolean) => Promise<void>;
}

/**
 * Wi-Fi access (DOR-2930): read whether other devices on this network can open
 * DorkOS, and flip it.
 *
 * A refusal carrying `AUTH_REQUIRED_FOR_EXPOSURE` is the same one the tunnel
 * meets, so it takes the same path: owner-account setup, then the switch again.
 */
export function useLanAccess(): LanAccessModel {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: lanAccessKey,
    queryFn: () => transport.getLanAccess(),
    refetchInterval: REFRESH_MS,
  });

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      /** Send the switch, keep the status and config current, and report a refusal. */
      const send = async (value: boolean): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
          const next = await transport.setLanAccess(value);
          queryClient.setQueryData(lanAccessKey, next);
          // The switch is a setting too; keep every reader of the config current.
          void queryClient.invalidateQueries({ queryKey: configKeys.current() });
        } catch (err) {
          if ((err as { code?: string } | null)?.code === 'AUTH_REQUIRED_FOR_EXPOSURE') {
            // Login first, then the same switch again once the owner exists.
            requestOwnerSetup({
              reason: 'exposure',
              message: 'Wi-Fi access needs a login.',
              onComplete: () => void send(true),
            });
          } else {
            setError(err instanceof Error && err.message ? err.message : 'Could not change that.');
          }
        } finally {
          setBusy(false);
        }
      };
      await send(enabled);
    },
    [transport, queryClient]
  );

  return { status, busy, error, setEnabled };
}
