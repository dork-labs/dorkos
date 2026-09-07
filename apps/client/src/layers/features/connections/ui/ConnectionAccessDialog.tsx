import { useEffect, useMemo, useState } from 'react';
import { Check, Clock3, RefreshCw, ShieldAlert } from 'lucide-react';
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
import {
  Badge,
  Button,
  Checkbox,
  QueryErrorState,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Skeleton,
} from '@/layers/shared/ui';
import {
  changedGrantSelections,
  revisionIdsForAccessLevel,
  selectionsFromPreview,
  type AgentOperationSelections,
} from '../lib/reconciliation-selection';

interface ConnectionAccessDialogProps {
  /** Stable DorkOS connection whose action access is being reviewed. */
  connectionId: string | null;
  /** Whether the permission editor is open. */
  open: boolean;
  /** Close or reopen the editor. */
  onOpenChange: (open: boolean) => void;
}

/** Human label for a provider operation slug without exposing internal IDs. */
function operationLabel(slug: string): string {
  const leaf = slug.split('.').at(-1) ?? slug;
  return leaf.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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

/** Exact operation-revision access editor backed by one complete server snapshot. */
export function ConnectionAccessDialog({
  connectionId,
  open,
  onOpenChange,
}: ConnectionAccessDialogProps) {
  const previewMutation = usePreviewConnectorReconciliation();
  const applyMutation = useApplyConnectorReconciliation();
  const syncQuery = useConnectorConnection(connectionId, false);
  const [selections, setSelections] = useState<AgentOperationSelections>({});
  const [advancedAgentId, setAdvancedAgentId] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [saveOutcome, setSaveOutcome] = useState<ConnectorReconciliationApplyResponse | null>(null);

  const preview = previewMutation.data;
  useEffect(() => {
    if (!open || !connectionId) return;
    previewMutation.reset();
    applyMutation.reset();
    previewMutation.mutate(
      { connectionId },
      { onSuccess: (nextPreview) => setSelections(selectionsFromPreview(nextPreview)) }
    );
    // Mutations are stable enough for this open transition; including their
    // changing result objects would recreate a preview after every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId]);

  const changed = useMemo(
    () => (preview ? changedGrantSelections(preview, selections) : []),
    [preview, selections]
  );

  const refresh = () => {
    if (!connectionId) return;
    setNeedsRefresh(false);
    setSaveOutcome(null);
    applyMutation.reset();
    previewMutation.reset();
    previewMutation.mutate(
      { connectionId },
      { onSuccess: (nextPreview) => setSelections(selectionsFromPreview(nextPreview)) }
    );
  };

  const apply = () => {
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
  const pendingAdds = saveOutcome?.grants.some((grant) => grant.operationRevisionIds.length > 0);
  const pendingRemovals = saveOutcome?.grants.some(
    (grant) => grant.operationRevisionIds.length === 0
  );

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="connector-access-dialog"
        className="max-h-[90vh] sm:max-w-3xl [&>[data-slot=dialog-content-close]]:absolute [&>[data-slot=dialog-content-close]]:top-4 [&>[data-slot=dialog-content-close]]:right-4 [&>[data-slot=dialog-content-close]]:m-0 [&>[data-slot=dialog-content-close]]:opacity-100"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Choose agent access</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Pick the exact actions each agent may take with this account. Existing access stays
            selected until you change it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4 pb-4">
          {previewMutation.isPending ? (
            <div className="space-y-3" aria-label="Loading account actions">
              <Skeleton className="h-20 rounded-lg" />
              <Skeleton className="h-36 rounded-lg" />
            </div>
          ) : previewMutation.isError ? (
            <QueryErrorState
              title="Couldn’t load account actions"
              description="Nothing changed. Try loading the current access again."
              onRetry={refresh}
              isRetrying={previewMutation.isPending}
            />
          ) : needsRefresh ? (
            <div className="border-destructive/30 bg-destructive/5 space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
                <div>
                  <p role="alert" className="text-sm font-medium">
                    We couldn’t confirm that access was saved
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Reload the current access before making another change.
                  </p>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={refresh}>
                <RefreshCw className="size-4" aria-hidden />
                Reload current access
              </Button>
            </div>
          ) : saved ? (
            <div className="border-success/30 bg-success/5 flex items-start gap-3 rounded-lg border p-4">
              <Check className="text-success mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p data-testid="connector-access-outcome" className="text-sm font-medium">
                  Access updated
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                  Access is ready for the agents you changed.
                </p>
              </div>
            </div>
          ) : needsReconciliation ? (
            <div className="border-warning/30 bg-warning/5 flex items-start gap-3 rounded-lg border p-4">
              <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p data-testid="connector-access-outcome" className="text-sm font-medium">
                  Access needs review
                </p>
                <p className="text-muted-foreground mt-1 text-sm">
                  Available actions changed. Reload the current access before making another change.
                </p>
              </div>
            </div>
          ) : saveOutcome?.authoritySync.status === 'pending' ? (
            <div className="border-warning/30 bg-warning/5 space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <Clock3 className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                <div>
                  <p data-testid="connector-access-outcome" className="text-sm font-medium">
                    Access update pending
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {pendingAdds && pendingRemovals
                      ? 'Removed access is already closed. New access stays unavailable until synchronization finishes.'
                      : pendingRemovals
                        ? 'Removed access is already closed. The service is still removing access.'
                        : 'New access is saved but remains unavailable until synchronization finishes.'}
                  </p>
                </div>
              </div>
              {syncQuery.isError && (
                <p role="alert" className="text-destructive text-sm">
                  Couldn’t check the current sync status. The access change was not repeated.
                </p>
              )}
            </div>
          ) : saveOutcome?.authoritySync.status === 'failed' ? (
            <div className="border-destructive/30 bg-destructive/5 space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
                <div>
                  <p
                    data-testid="connector-access-outcome"
                    role="alert"
                    className="text-sm font-medium"
                  >
                    Access sync failed
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {saveOutcome.authoritySync.reason} Agents cannot use this change. Check your
                    account setup, then try again.
                  </p>
                </div>
              </div>
              {syncQuery.isError && (
                <p role="alert" className="text-destructive text-sm">
                  Couldn’t check the current sync status. The access change was not repeated.
                </p>
              )}
            </div>
          ) : preview ? (
            <ReconciliationEditor
              preview={preview}
              selections={selections}
              setSelections={setSelections}
              advancedAgentId={advancedAgentId}
              setAdvancedAgentId={setAdvancedAgentId}
            />
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {saved ? 'Done' : saveOutcome ? 'Close' : 'Cancel'}
          </Button>
          {needsReconciliation ? (
            <Button variant="secondary" onClick={refresh}>
              Reload current access
            </Button>
          ) : saveOutcome && !saved ? (
            <Button variant="secondary" onClick={checkSync} disabled={syncQuery.isFetching}>
              <RefreshCw className="size-4" aria-hidden />
              {syncQuery.isFetching ? 'Checking…' : 'Check sync status'}
            </Button>
          ) : !needsRefresh && preview && !saved ? (
            <Button onClick={apply} disabled={changed.length === 0 || applyMutation.isPending}>
              {applyMutation.isPending ? 'Saving…' : 'Save access'}
            </Button>
          ) : null}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ReconciliationEditor({
  preview,
  selections,
  setSelections,
  advancedAgentId,
  setAdvancedAgentId,
}: {
  preview: ConnectorReconciliationPreview;
  selections: AgentOperationSelections;
  setSelections: (next: AgentOperationSelections) => void;
  advancedAgentId: string | null;
  setAdvancedAgentId: (next: string | null) => void;
}) {
  return (
    <>
      <div>
        <p className="text-sm font-medium">{preview.connection.label}</p>
        <p className="text-muted-foreground text-xs">
          Choose a simple level for each agent. Open Advanced only when individual actions differ.
        </p>
      </div>

      {preview.agents.length === 0 ? (
        <p className="bg-muted/40 rounded-lg p-4 text-sm">
          Register an agent before granting account access.
        </p>
      ) : (
        <div className="space-y-2">
          {preview.agents.map((agent) => {
            const selected = new Set(selections[agent.agentId] ?? []);
            const read = revisionIdsForAccessLevel(preview.candidates, 'read');
            const readWrite = revisionIdsForAccessLevel(preview.candidates, 'read-write');
            const sorted = [...selected].sort();
            const same = (candidate: string[]) =>
              candidate.length === sorted.length &&
              candidate.every((value, index) => value === sorted[index]);
            const level =
              sorted.length === 0
                ? 'No access'
                : same(read)
                  ? 'Read'
                  : same(readWrite)
                    ? 'Read + write'
                    : 'Custom access';
            const advanced = advancedAgentId === agent.agentId;
            const setLevel = (next: 'none' | 'read' | 'read-write') =>
              setSelections({
                ...selections,
                [agent.agentId]: revisionIdsForAccessLevel(preview.candidates, next),
              });

            return (
              <fieldset key={agent.agentId} className="bg-muted/40 rounded-lg p-3">
                <legend className="sr-only">Access for {agent.displayName}</legend>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{agent.displayName}</p>
                    <p className="text-muted-foreground text-xs">{level}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={advanced}
                    onClick={() => setAdvancedAgentId(advanced ? null : agent.agentId)}
                  >
                    Advanced
                  </Button>
                </div>
                <div
                  className="mt-2 grid grid-cols-3 gap-1.5"
                  aria-label={`Quick access for ${agent.displayName}`}
                >
                  {(
                    [
                      ['none', 'No access'],
                      ['read', 'Read'],
                      ['read-write', 'Read + write'],
                    ] as const
                  ).map(([value, label]) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={level === label ? 'secondary' : 'outline'}
                      aria-pressed={level === label}
                      onClick={() => setLevel(value)}
                      className="px-2 text-xs"
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {advanced && (
                  <ul className="mt-3 space-y-1.5" data-testid={`advanced-access-${agent.agentId}`}>
                    {preview.candidates.map((candidate) => {
                      const checked = selected.has(candidate.operationRevisionId);
                      const cannotAdd = !candidate.supported && !checked;
                      return (
                        <li
                          key={candidate.operationRevisionId}
                          className="bg-background flex gap-3 rounded-md p-2.5"
                        >
                          <Checkbox
                            aria-label={`${operationLabel(candidate.operationSlug)} for ${agent.displayName}`}
                            checked={checked}
                            disabled={cannotAdd}
                            onCheckedChange={(next) => {
                              const updated = new Set(selected);
                              if (next === true) updated.add(candidate.operationRevisionId);
                              else updated.delete(candidate.operationRevisionId);
                              setSelections({
                                ...selections,
                                [agent.agentId]: [...updated].sort(),
                              });
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium">
                                {operationLabel(candidate.operationSlug)}
                              </span>
                              <Badge size="xs" variant="secondary">
                                {candidate.capabilityClassification}
                              </Badge>
                              {!candidate.supported && (
                                <Badge size="xs" variant="outline">
                                  No longer available
                                </Badge>
                              )}
                            </div>
                            <p className="text-muted-foreground mt-0.5 text-xs">
                              Version {candidate.toolkitVersion}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>
            );
          })}
        </div>
      )}
    </>
  );
}
