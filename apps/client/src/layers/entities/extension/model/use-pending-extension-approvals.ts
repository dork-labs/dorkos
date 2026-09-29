/**
 * Installed extensions waiting for a person to turn them on — the Activity
 * inbox's live queue for them (DOR-2517).
 *
 * @module entities/extension/model/use-pending-extension-approvals
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PendingExtensionApprovalsResponseSchema,
  type PendingExtensionApproval,
} from '@dorkos/shared/extension-approval-schemas';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { useEventSubscription } from '@/layers/shared/model';

/**
 * Query keys for the extension entity.
 *
 * Everything sits under `['extensions']`, the prefix Settings → Extensions uses
 * for its own list, so one invalidation after a change refreshes both.
 */
export const extensionQueryKeys = {
  all: ['extensions'] as const,
  list: () => [...extensionQueryKeys.all, 'list'] as const,
  pendingApprovals: () => [...extensionQueryKeys.all, 'pending-approvals'] as const,
};

/** Shared empty list, so an inbox with nothing waiting never mints a fresh array. */
const NO_APPROVALS: readonly PendingExtensionApproval[] = [];

/** What {@link usePendingExtensionApprovals} answers with. */
export interface PendingExtensionApprovalsState {
  /** Every extension waiting to be turned on, oldest first. */
  approvals: readonly PendingExtensionApproval[];
  /** True while the list is still on its first read. */
  isLoading: boolean;
}

/**
 * Read the list once.
 *
 * @returns The extensions waiting, oldest first.
 */
async function fetchPendingApprovals(): Promise<PendingExtensionApproval[]> {
  const res = await fetch(`${resolveApiBaseUrl()}/extensions/pending-approvals`);
  if (!res.ok) {
    throw new Error(`Couldn’t check for extensions waiting to be turned on (${res.status})`);
  }
  return PendingExtensionApprovalsResponseSchema.parse(await res.json()).approvals;
}

/**
 * Every installed extension waiting for a person to turn it on, kept live.
 *
 * Read on mount, then re-read whenever the server says the set may have
 * changed: an `extension.approval` arriving or ending (`standing_pending` /
 * `standing_resolved`), or any extension reloading (`extension_reloaded`, which
 * is what an approval, an install or a re-scan broadcasts). The server is the
 * authority on what is waiting, so this re-reads rather than replaying the
 * transition locally.
 */
export function usePendingExtensionApprovals(): PendingExtensionApprovalsState {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: extensionQueryKeys.pendingApprovals(),
    queryFn: fetchPendingApprovals,
  });

  const refresh = (raw: unknown) => {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind !== undefined && kind !== 'extension.approval') return;
    void queryClient.invalidateQueries({ queryKey: extensionQueryKeys.pendingApprovals() });
  };
  useEventSubscription('standing_pending', refresh);
  useEventSubscription('standing_resolved', refresh);
  useEventSubscription('extension_reloaded', () => refresh(null));

  return { approvals: data ?? NO_APPROVALS, isLoading };
}
