/**
 * Apply-a-Shape mutation for the switcher UI. Wraps the reusable
 * {@link applyShapeAction} (`entities/shapes`) with a live UI dispatcher (origin
 * `'user'` — the person picked the Shape) and the auto-follow agent switch, and
 * exposes TanStack Query's pending/error state to the dialog.
 *
 * @module features/shapes/model/use-apply-shape
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UiCommand } from '@dorkos/shared/types';
import type { ApplyShapeResult } from '@dorkos/shared/marketplace-schemas';
import { executeUiCommand, type DispatcherContext } from '@/layers/shared/lib';
import { useAppStore, useTheme, useTransport } from '@/layers/shared/model';
import { applyShapeAction } from '@/layers/entities/shapes';
import { useSwitchAgentCwd } from './use-switch-agent-cwd';

/** Variables for the apply mutation. */
export interface ApplyShapeVars {
  /** The installed Shape name to apply. */
  name: string;
  /** Human-facing name for the outcome toast. */
  label?: string;
}

/**
 * @returns The apply mutation — `mutate({ name, label })` applies the Shape and
 *   resolves with the full {@link ApplyShapeResult} (chrome, warnings, offers).
 */
export function useApplyShape() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();
  const switchAgent = useSwitchAgentCwd();

  return useMutation<ApplyShapeResult, Error, ApplyShapeVars>({
    mutationFn: ({ name, label }) => {
      const dispatch = (command: UiCommand): void => {
        // Read the store fresh per command so the layout applies against live state.
        const ctx: DispatcherContext = {
          store: useAppStore.getState(),
          setTheme,
          supportsTerminal: transport.supportsTerminal,
        };
        executeUiCommand(ctx, command, 'user');
      };
      return applyShapeAction(name, { transport, queryClient, dispatch, switchAgent, label });
    },
  });
}
