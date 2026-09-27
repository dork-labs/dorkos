import { useEffect, useRef, useState } from 'react';
import type {
  ConnectorReconciliationApplyResponse,
  ConnectorReconciliationGrantSelection,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorAuthoritySyncState } from '@dorkos/shared/connector-resource-schemas';
import {
  useApplyConnectorReconciliation,
  useConnectorConnection,
  usePreviewConnectorReconciliation,
} from '@/layers/entities/connectors';

/** True when the server accepted exactly the replacement sets that were sent. */
function acceptedExactGrants(
  expected: ConnectorReconciliationGrantSelection[],
  actual: ConnectorReconciliationGrantSelection[]
): boolean {
  const normalize = (grants: ConnectorReconciliationGrantSelection[]) =>
    grants
      .map((grant) => ({
        agentId: grant.agentId,
        operationRevisionIds: [...grant.operationRevisionIds].sort(),
      }))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  return JSON.stringify(normalize(expected)) === JSON.stringify(normalize(actual));
}

/** Options for {@link useAccessReconciliation}. */
export interface UseAccessReconciliationOptions {
  /** Stable connection whose access is being changed; `null` loads nothing. */
  connectionId: string | null;
  /**
   * Whether the surface is showing; a transition to true loads a fresh
   * snapshot. Outcomes are not cleared by it, so a caller that switches
   * connections remounts (keys) the surface rather than reusing one instance.
   */
  active: boolean;
  /** Called with every freshly loaded snapshot, so the caller can seed its selection. */
  onPreview?: (preview: ConnectorReconciliationPreview) => void;
}

/**
 * One access decision against the server's reconciliation boundary, with the
 * honest outcome model both access surfaces share.
 *
 * It loads a complete snapshot, writes only the replacement sets it is given,
 * and never reports success the server did not confirm: a response that names
 * different grants, or a failed request that may have committed anyway, is
 * "couldn't confirm" and demands a fresh snapshot rather than a replay. A
 * pending or failed authority sync stays that way until an explicit check
 * reads it back.
 *
 * @param options - Connection, visibility, and snapshot callback.
 */
export function useAccessReconciliation({
  connectionId,
  active,
  onPreview,
}: UseAccessReconciliationOptions) {
  const previewMutation = usePreviewConnectorReconciliation();
  const applyMutation = useApplyConnectorReconciliation();
  const syncQuery = useConnectorConnection(connectionId, false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [saveOutcome, setSaveOutcome] = useState<ConnectorReconciliationApplyResponse | null>(null);
  const onPreviewRef = useRef(onPreview);
  useEffect(() => {
    onPreviewRef.current = onPreview;
  });

  const load = () => {
    if (!connectionId) return;
    previewMutation.reset();
    applyMutation.reset();
    previewMutation.mutate(
      { connectionId },
      { onSuccess: (nextPreview) => onPreviewRef.current?.(nextPreview) }
    );
  };

  useEffect(() => {
    if (!active || !connectionId) return;
    load();
    // Mutations are stable enough for this open transition; including their
    // changing result objects would recreate a preview after every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connectionId]);

  const preview = previewMutation.data;

  /** Discard every outcome and read the current authority again. */
  const refresh = () => {
    setNeedsRefresh(false);
    setSaveOutcome(null);
    load();
  };

  /** Write exactly these replacement sets against the loaded snapshot. */
  const apply = (changed: ConnectorReconciliationGrantSelection[]) => {
    if (!preview || changed.length === 0) return;
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      setNeedsRefresh(true);
      return;
    }
    applyMutation.mutate(
      { previewId: preview.previewId, grants: changed },
      {
        onSuccess: (result) => {
          if (
            result.connectionId !== preview.connection.connectionId ||
            !acceptedExactGrants(changed, result.grants)
          ) {
            setNeedsRefresh(true);
            previewMutation.reset();
            return;
          }
          setSaveOutcome(result);
        },
        onError: () => {
          // A failed response may have arrived after the server committed. Do
          // not replay it. Discard the snapshot and read authority again.
          setNeedsRefresh(true);
          previewMutation.reset();
        },
      }
    );
  };

  /** Read the saved change back and report its current sync state, never repeating the write. */
  const checkSync = () => {
    void syncQuery.refetch().then((result) => {
      if (!result.data || !saveOutcome || !connectionId) return;
      const expectedGrants = saveOutcome.grants;
      const canonicalGrants = expectedGrants.map((expected) => ({
        agentId: expected.agentId,
        operationRevisionIds:
          result.data.agents.find((agent) => agent.agentId === expected.agentId)
            ?.operationRevisionIds ?? [],
      }));
      if (
        result.data.connection.connectionId !== connectionId ||
        saveOutcome.connectionId !== connectionId ||
        !acceptedExactGrants(expectedGrants, canonicalGrants)
      ) {
        setNeedsRefresh(true);
        setSaveOutcome(null);
        previewMutation.reset();
        return;
      }

      const changedAgents = expectedGrants.flatMap((expected) => {
        const agent = result.data.agents.find(
          (candidate) => candidate.agentId === expected.agentId
        );
        return agent ? [agent] : [];
      });
      const reconciliationStatus =
        result.data.connection.reconciliationStatus !== 'ready'
          ? result.data.connection.reconciliationStatus
          : (changedAgents.find((agent) => agent.reconciliationStatus !== 'ready')
              ?.reconciliationStatus ?? 'ready');
      const authorityStates: ConnectorAuthoritySyncState[] = [
        result.data.connection.authoritySync,
        ...changedAgents.map((agent) => agent.authoritySync),
      ];
      const failedAuthority = authorityStates.find(
        (state): state is Extract<ConnectorAuthoritySyncState, { status: 'failed' }> =>
          state.status === 'failed'
      );
      const authoritySync: ConnectorAuthoritySyncState =
        failedAuthority ??
        (authorityStates.some((state) => state.status === 'pending')
          ? { status: 'pending' }
          : { status: 'ready' });
      setSaveOutcome({ ...saveOutcome, reconciliationStatus, authoritySync });
    });
  };

  const saved =
    saveOutcome?.reconciliationStatus === 'ready' && saveOutcome.authoritySync.status === 'ready';
  const needsReconciliation = saveOutcome !== null && saveOutcome.reconciliationStatus !== 'ready';

  return {
    /** The loaded snapshot, when one is current. */
    preview,
    /** A snapshot is loading. */
    isLoading: previewMutation.isPending,
    /** The snapshot could not be loaded; nothing changed. */
    loadFailed: previewMutation.isError,
    /** A write is in flight. */
    isSaving: applyMutation.isPending,
    /** The last write could not be confirmed; reload before another change. */
    needsRefresh,
    /** The server's confirmed answer to the last write. */
    saveOutcome,
    /** The confirmed write is ready for every agent it changed. */
    saved,
    /** The operation catalog changed underneath the write; reload before another change. */
    needsReconciliation,
    /** A sync check is in flight. */
    isCheckingSync: syncQuery.isFetching,
    /** The last sync check could not be read. */
    syncCheckFailed: syncQuery.isError,
    refresh,
    apply,
    checkSync,
  };
}

/** Everything {@link useAccessReconciliation} returns. */
export type AccessReconciliation = ReturnType<typeof useAccessReconciliation>;
