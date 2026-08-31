/**
 * Bind {@link switchAgentCwd} to the live store + router so the switcher can
 * follow an offered arrival agent (W1a). Kept in the feature layer because it
 * composes the `entities/session` switch seam — an entity may not import a
 * sibling entity, but a feature may compose both.
 *
 * @module features/shapes/model/use-switch-agent-cwd
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { switchAgentCwd } from '@/layers/entities/session';

/**
 * @returns A callback that switches the cockpit to an agent's working
 *   directory, reading the store fresh per call.
 */
export function useSwitchAgentCwd(): (cwd: string) => void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const transport = useTransport();
  return useCallback(
    (cwd: string) =>
      void switchAgentCwd(cwd, {
        store: useAppStore.getState(),
        queryClient,
        transport,
        currentLocation: () => router.state.location,
        navigate: (search) => void navigate({ to: '/session', search }),
      }),
    [queryClient, transport, router, navigate]
  );
}
