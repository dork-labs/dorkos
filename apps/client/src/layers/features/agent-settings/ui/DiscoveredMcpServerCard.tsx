import { useCallback, useState } from 'react';
import { Loader2, Plus, ShieldAlert } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useImportAgentMcpServer } from '@/layers/entities/agent';
import type { CapabilityApprovalRequired, McpServerEntry } from '@dorkos/shared/transport';
import { classifyFailure, type McpCardStatus } from '../lib/mcp-server-state';
import { deriveDiscoveredScope, parseMcpServerName, scopeSentence } from '../lib/mcp-scope';
import { McpServerCard } from './McpServerCard';
import { McpServerCardDetails } from './McpServerCardDetails';

/** How a runtime's reported status reads on a card DorkOS does not manage. */
function discoveredStatus(entry: McpServerEntry): McpCardStatus {
  switch (entry.status) {
    case 'connected':
      return 'connected';
    case 'failed':
      return classifyFailure(entry.error);
    case 'needs-auth':
      return 'needs-sign-in';
    case 'pending':
      return 'connecting';
    case 'disabled':
      return 'off';
    default:
      return 'not-checked';
  }
}

/**
 * What the confirmation says about where a server lives today.
 *
 * The old copy — "this brings the … server from this project's config under
 * DorkOS management" — described DorkOS's bookkeeping. This describes what the
 * person gets: the same server, now with the switches on it.
 *
 * @param args.displayName - The server's readable name.
 * @param args.scope - Where the server came from.
 * @param args.pluginName - The plugin it ships with, when its name says so.
 */
function confirmSentence(args: {
  displayName: string;
  scope: ReturnType<typeof deriveDiscoveredScope>;
  pluginName: string | null;
}): string {
  const { displayName, scope, pluginName } = args;
  const origin =
    scope === 'plugin' && pluginName
      ? `comes with the ${pluginName} plugin`
      : scope === 'project'
        ? 'comes from this project’s own config'
        : 'comes from your computer-wide config';
  return `${displayName} ${origin}. Manage it here to enable, disable, or sign in from DorkOS.`;
}

/** Props for {@link DiscoveredMcpServerCard}. */
export interface DiscoveredMcpServerCardProps {
  /** The runtime's roster entry for a server with no managed match. */
  entry: McpServerEntry;
  /** The agent the server would be added to. */
  agentId: string;
  /** Display label for the agent, used in the confirm copy. */
  agentLabel: string;
  /** Whether the agent's runtime can run DorkOS-managed servers (gates the action). */
  canImport: boolean;
}

/**
 * One server the runtime loads that DorkOS does not manage — from the project's
 * own config, from a plugin, or from the computer-wide config.
 *
 * It reads exactly like a managed card, because a person scanning this panel is
 * asking the same question of every server ("is this working, and what do I do
 * about it?"). What differs is what it can offer: no switch, and one action —
 * add it to this agent, which promotes it into the managed store through the
 * same operator-approval flow as Add (`mcp.import` answers `approval_required`
 * first, the operator confirms, and the granted retry writes it).
 */
export function DiscoveredMcpServerCard({
  entry,
  agentId,
  agentLabel,
  canImport,
}: DiscoveredMcpServerCardProps) {
  const importServer = useImportAgentMcpServer();
  const [pending, setPending] = useState<CapabilityApprovalRequired | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const result = await importServer.mutateAsync({ input: { agentId, name: entry.name } });
      if (result.status === 'approval_required') setPending(result.approval);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the server.');
    }
  }, [importServer, agentId, entry.name]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    setError(null);
    try {
      const result = await importServer.mutateAsync({
        input: { agentId, name: entry.name },
        approval: pending,
      });
      // On success the card becomes a managed one via query invalidation; nothing
      // to reset here because this component unmounts with the discovered list.
      if (result.status !== 'ok') setError('Adding it still needs approval. Try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the server.');
    }
  }, [importServer, agentId, entry.name, pending]);

  const parsed = parseMcpServerName(entry.name);
  const scope = deriveDiscoveredScope(entry, parsed);

  if (pending) {
    return (
      <div className="border-border/60 mb-2 space-y-3 rounded-md border p-3 last:mb-0">
        <div className="flex items-start gap-2">
          <ShieldAlert className="text-status-warning mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Add &ldquo;{parsed.displayName}&rdquo; to {agentLabel}?
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {confirmSentence({
                displayName: parsed.displayName,
                scope,
                pluginName: parsed.pluginName,
              })}
            </p>
          </div>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPending(null)}
            disabled={importServer.isPending}
            className="focus-visible:ring-2"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={confirm}
            disabled={importServer.isPending}
            className="focus-visible:ring-2"
          >
            {importServer.isPending ? 'Adding…' : 'Add to agent'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <McpServerCard
      displayName={parsed.displayName}
      rawName={entry.name}
      scope={scope}
      pluginName={parsed.pluginName}
      status={discoveredStatus(entry)}
      sentence={scopeSentence(scope, parsed.pluginName)}
      managed={false}
      actions={
        canImport ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={start}
              disabled={importServer.isPending}
              aria-label={`Add ${entry.name} to agent`}
              className="gap-1.5 focus-visible:ring-2"
            >
              {importServer.isPending ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-3.5" aria-hidden />
              )}
              Add to agent
            </Button>
            {error && <p className="text-destructive text-xs">{error}</p>}
          </>
        ) : undefined
      }
      details={
        <McpServerCardDetails
          scope={scope}
          pluginName={parsed.pluginName}
          rawName={parsed.rawName}
          displayName={parsed.displayName}
          error={entry.error}
        />
      }
    />
  );
}
