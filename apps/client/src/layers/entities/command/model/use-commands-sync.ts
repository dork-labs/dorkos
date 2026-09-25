import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';

/**
 * Keep the command registry honest after a marketplace install/uninstall.
 *
 * The server broadcasts a `commands_changed` event on the unified `/api/events`
 * stream once it has hot-reloaded the runtime's plugin set (UX-12). This hook
 * invalidates every `['commands']` query so the chat command palette re-fetches
 * the runtime's authoritative list — newly-installed plugin commands (e.g.
 * `/flow:*`) appear, removed ones disappear — without a page reload.
 */
export function useCommandsSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('commands_changed', () => {
    void queryClient.invalidateQueries({ queryKey: ['commands'] });
  });
}
