import { useEffect, useId, useMemo, useState } from 'react';
import { Check, RefreshCw, ShieldAlert } from 'lucide-react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  useApplyConnectorReconciliation,
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

/** Exact operation-revision access editor backed by one complete server snapshot. */
export function ConnectionAccessDialog({
  connectionId,
  open,
  onOpenChange,
}: ConnectionAccessDialogProps) {
  const previewMutation = usePreviewConnectorReconciliation();
  const applyMutation = useApplyConnectorReconciliation();
  const [selections, setSelections] = useState<AgentOperationSelections>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [saved, setSaved] = useState(false);

  const preview = previewMutation.data;
  useEffect(() => {
    if (!open || !connectionId) return;
    setShowAdvanced(false);
    setNeedsRefresh(false);
    setSaved(false);
    previewMutation.reset();
    applyMutation.reset();
    previewMutation.mutate({ connectionId });
    // Mutations are stable enough for this open transition; including their
    // changing result objects would recreate a preview after every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connectionId]);

  useEffect(() => {
    if (preview) setSelections(selectionsFromPreview(preview));
  }, [preview]);

  const changed = useMemo(
    () => (preview ? changedGrantSelections(preview, selections) : []),
    [preview, selections]
  );

  const refresh = () => {
    if (!connectionId) return;
    setNeedsRefresh(false);
    setSaved(false);
    applyMutation.reset();
    previewMutation.reset();
    previewMutation.mutate({ connectionId });
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
        onSuccess: () => setSaved(true),
        onError: () => {
          // A failed response may have arrived after the server committed. Do
          // not replay it. Discard the snapshot and read authority again.
          setNeedsRefresh(true);
          previewMutation.reset();
        },
      }
    );
  };

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
                  Only the agents you changed were updated.
                </p>
              </div>
            </div>
          ) : preview ? (
            <ReconciliationEditor
              preview={preview}
              selections={selections}
              setSelections={setSelections}
              showAdvanced={showAdvanced}
              setShowAdvanced={setShowAdvanced}
            />
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {saved ? 'Done' : 'Cancel'}
          </Button>
          {!saved && !needsRefresh && preview && (
            <Button onClick={apply} disabled={changed.length === 0 || applyMutation.isPending}>
              {applyMutation.isPending ? 'Saving…' : 'Save access'}
            </Button>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ReconciliationEditor({
  preview,
  selections,
  setSelections,
  showAdvanced,
  setShowAdvanced,
}: {
  preview: ConnectorReconciliationPreview;
  selections: AgentOperationSelections;
  setSelections: (next: AgentOperationSelections) => void;
  showAdvanced: boolean;
  setShowAdvanced: (next: boolean) => void;
}) {
  const sensitiveActionsId = useId();
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{preview.connection.label}</p>
          <p className="text-muted-foreground text-xs">
            {preview.candidates.length} available actions
          </p>
        </div>
        <label
          htmlFor={sensitiveActionsId}
          className="focus-within:ring-ring flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm focus-within:ring-2"
        >
          <Checkbox
            id={sensitiveActionsId}
            checked={showAdvanced}
            onCheckedChange={(checked) => setShowAdvanced(checked === true)}
          />
          Show sensitive actions
        </label>
      </div>

      {preview.agents.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border p-4 text-sm">
          Register an agent before granting account access.
        </p>
      ) : (
        <div className="space-y-4">
          {preview.agents.map((agent) => {
            const selected = new Set(selections[agent.agentId] ?? []);
            const visible = preview.candidates.filter(
              (candidate) =>
                candidate.capabilityClassification !== 'destructive' ||
                showAdvanced ||
                selected.has(candidate.operationRevisionId)
            );
            const setLevel = (level: 'none' | 'read' | 'read-write') =>
              setSelections({
                ...selections,
                [agent.agentId]: revisionIdsForAccessLevel(preview.candidates, level),
              });
            return (
              <fieldset key={agent.agentId} className="space-y-3 rounded-lg border p-4">
                <legend className="px-1 text-sm font-semibold">{agent.displayName}</legend>
                <div
                  className="flex flex-wrap gap-2"
                  aria-label={`Quick access for ${agent.displayName}`}
                >
                  <Button size="sm" variant="outline" onClick={() => setLevel('none')}>
                    No access
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setLevel('read')}>
                    Read only
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setLevel('read-write')}>
                    Read + write
                  </Button>
                </div>
                <ul className="divide-y rounded-md border">
                  {visible.map((candidate) => {
                    const checked = selected.has(candidate.operationRevisionId);
                    const cannotAdd = !candidate.supported && !checked;
                    return (
                      <li key={candidate.operationRevisionId} className="flex gap-3 p-3">
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
                          <div className="flex flex-wrap items-center gap-2">
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
              </fieldset>
            );
          })}
        </div>
      )}
    </>
  );
}
