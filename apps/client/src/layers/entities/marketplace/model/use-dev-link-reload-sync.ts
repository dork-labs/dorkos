import { useEventSubscription } from '@/layers/shared/model';
import type { DevLinkReloadedEvent } from '@dorkos/shared/marketplace-schemas';
import { useDevLinkReloadStore } from './dev-link-reload-store';
import { useInvalidateDevLinkViews } from './use-dev-links';

/** Whether a stream payload has the shape of a dev link reload. */
function isReloadEvent(data: unknown): data is DevLinkReloadedEvent {
  if (typeof data !== 'object' || data === null) return false;
  const event = data as Partial<DevLinkReloadedEvent>;
  return (
    typeof event.name === 'string' &&
    (event.scope === 'global' || event.scope === 'project') &&
    typeof event.at === 'string' &&
    Array.isArray(event.actions)
  );
}

/**
 * Keep dev links current after an edit in a linked folder (DOR-2696). The
 * server broadcasts `marketplace_dev_link_reloaded` to the operator once each
 * burst of edits has been acted on; this keeps the event (so the Installed row
 * can say "Reloaded 4s ago" or that it couldn't reload) and refreshes the
 * installed list, the dev links and the extension list. Mounted once, by the
 * app shell, so a reload that lands while the Marketplace is closed is still
 * there when it opens.
 */
export function useDevLinkReloadSync(): void {
  const record = useDevLinkReloadStore((s) => s.record);
  const invalidate = useInvalidateDevLinkViews();
  useEventSubscription('marketplace_dev_link_reloaded', (data) => {
    if (!isReloadEvent(data)) return;
    record(data);
    invalidate();
  });
}
