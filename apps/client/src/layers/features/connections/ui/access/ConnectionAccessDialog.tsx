import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  accessLevelRevisionIds,
  actionNameFromSlug,
  OPERATION_CLASSIFICATION_LABELS,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { useConnectorConnections } from '@/layers/entities/connectors';
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
  selectionsFromPreview,
  type AgentOperationSelections,
} from '../../lib/reconciliation-selection';
import { olderVersionIds } from '../../lib/older-versions';
import { useAccessReconciliation } from '../../model/use-access-reconciliation';
import { AccessOutcome } from './AccessOutcome';

interface ConnectionAccessDialogProps {
  /** Stable DorkOS connection whose action access is being reviewed. */
  connectionId: string | null;
  /** Whether the permission editor is open. */
  open: boolean;
  /** Close or reopen the editor. */
  onOpenChange: (open: boolean) => void;
}

/** Exact operation-revision access editor backed by one complete server snapshot. */
export function ConnectionAccessDialog({
  connectionId,
  open,
  onOpenChange,
}: ConnectionAccessDialogProps) {
  const [selections, setSelections] = useState<AgentOperationSelections>({});
  const [advancedAgentId, setAdvancedAgentId] = useState<string | null>(null);
  const access = useAccessReconciliation({
    connectionId,
    active: open,
    onPreview: (nextPreview) => setSelections(selectionsFromPreview(nextPreview)),
  });
  const { preview, saveOutcome, saved, needsReconciliation, needsRefresh } = access;
  // Why the owner is here, in the server's words, when the account is waiting
  // on them: a review, or a change the service refused. Either one is settled
  // by confirming the access as it stands, so that needs no edit.
  const readiness = useConnectorConnections().data?.connections.find(
    (connection) => connection.connectionId === connectionId
  )?.readiness;
  const confirmable =
    readiness?.reason === 'needs_review' || readiness?.reason === 'access_update_failed';

  const changed = useMemo(
    () => (preview ? changedGrantSelections(preview, selections) : []),
    [preview, selections]
  );
  const outcome = needsRefresh || saveOutcome !== null;
  const confirming = confirmable && changed.length === 0;

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
          {access.isLoading ? (
            <div className="space-y-3" aria-label="Loading account actions">
              <Skeleton className="h-20 rounded-lg" />
              <Skeleton className="h-36 rounded-lg" />
            </div>
          ) : access.loadFailed ? (
            <QueryErrorState
              title="Couldn’t load account actions"
              description="Nothing changed. Try loading the current access again."
              onRetry={access.refresh}
              isRetrying={access.isLoading}
            />
          ) : outcome ? (
            <AccessOutcome access={access} />
          ) : preview ? (
            <>
              {confirmable && readiness && (
                <p
                  data-testid="access-dialog-cause"
                  className="bg-status-warning-bg text-status-warning-fg rounded-lg p-3 text-sm"
                >
                  {readiness.copy.owner} If what you see below is right, confirm it.
                </p>
              )}
              <ReconciliationEditor
                preview={preview}
                selections={selections}
                setSelections={setSelections}
                advancedAgentId={advancedAgentId}
                setAdvancedAgentId={setAdvancedAgentId}
              />
            </>
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {saved ? 'Done' : saveOutcome ? 'Close' : 'Cancel'}
          </Button>
          {needsReconciliation ? (
            <Button variant="secondary" onClick={access.refresh}>
              Reload current access
            </Button>
          ) : saveOutcome && !saved ? (
            <Button variant="secondary" onClick={access.checkSync} disabled={access.isCheckingSync}>
              <RefreshCw className="size-4" aria-hidden />
              {access.isCheckingSync ? 'Checking…' : 'Check if it’s done'}
            </Button>
          ) : !needsRefresh && preview && !saved ? (
            <Button
              onClick={() => access.apply(changed, undefined, { confirm: confirming })}
              disabled={(changed.length === 0 && !confirmable) || access.isSaving}
            >
              {access.isSaving ? 'Saving…' : confirming ? 'Confirm access' : 'Save access'}
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

      {/* The levels below are what each agent has by name. Sharing with every
          agent adds to them, so "No access" here is not the whole answer. */}
      {preview.everyAgent.operationRevisionIds.length > 0 && (
        <p data-testid="exact-editor-every-agent" className="bg-muted/40 rounded-lg p-3 text-sm">
          Every agent also has {preview.everyAgent.operationRevisionIds.length}{' '}
          {preview.everyAgent.operationRevisionIds.length === 1 ? 'action' : 'actions'} here through
          “Every agent”, including agents you add later. The levels below are only what each agent
          has by name. To take that away, stop sharing this account with every agent.
        </p>
      )}

      {preview.agents.length === 0 ? (
        <p className="bg-muted/40 rounded-lg p-4 text-sm">
          Register an agent before granting account access.
        </p>
      ) : (
        <div className="space-y-2">
          {preview.agents.map((agent) => {
            const older = olderVersionIds(preview.candidates);
            const selection = selections[agent.agentId];
            const selected = new Set(selection?.operationRevisionIds ?? []);
            // The level the owner chose, kept as the app changes; ticking
            // single actions below makes it exact actions instead.
            const level =
              selection?.level === 'read'
                ? 'Read'
                : selection?.level === 'read-write'
                  ? 'Read + write'
                  : selected.size === 0
                    ? 'No access'
                    : 'Custom access';
            const advanced = advancedAgentId === agent.agentId;
            const setLevel = (next: 'none' | 'read' | 'read-write') =>
              setSelections({
                ...selections,
                [agent.agentId]: {
                  operationRevisionIds: accessLevelRevisionIds(preview.candidates, next),
                  ...(next !== 'none' && { level: next }),
                },
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
                            aria-label={`${actionNameFromSlug(candidate.operationSlug, preview.connection.toolkit)} for ${agent.displayName}`}
                            checked={checked}
                            disabled={cannotAdd}
                            onCheckedChange={(next) => {
                              const updated = new Set(selected);
                              if (next === true) updated.add(candidate.operationRevisionId);
                              else updated.delete(candidate.operationRevisionId);
                              setSelections({
                                ...selections,
                                [agent.agentId]: { operationRevisionIds: [...updated].sort() },
                              });
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium">
                                {actionNameFromSlug(
                                  candidate.operationSlug,
                                  preview.connection.toolkit
                                )}
                              </span>
                              <Badge
                                size="xs"
                                variant={
                                  candidate.capabilityClassification === 'destructive'
                                    ? 'destructive'
                                    : 'secondary'
                                }
                              >
                                {
                                  OPERATION_CLASSIFICATION_LABELS[
                                    candidate.capabilityClassification
                                  ]
                                }
                              </Badge>
                              {!candidate.supported && (
                                <Badge size="xs" variant="outline">
                                  No longer available
                                </Badge>
                              )}
                              {older.has(candidate.operationRevisionId) && (
                                <span className="text-muted-foreground text-xs">Older version</span>
                              )}
                            </div>
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
