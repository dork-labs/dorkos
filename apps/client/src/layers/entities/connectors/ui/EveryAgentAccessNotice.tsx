import { Cable } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useEveryAgentConnectorGrants } from '../model/use-connector-resources';
import { accessLevelWords, serviceName } from '../lib/access-copy';

/** Props for {@link EveryAgentAccessNotice}. */
export interface EveryAgentAccessNoticeProps {
  /** The arriving agent's name, as the person sees it; blank reads "This agent". */
  agentName: string;
  /** Layout classes from the host surface. */
  className?: string;
}

/**
 * Says what a new agent inherits before it is created: "Research Bot will get:
 * Gmail (read), Calendar (read). You can change this in Connections." (ADR
 * 260926-192625, guardrail 2).
 *
 * An app shared with every agent reaches this agent too, with no further yes,
 * so this line is how a new agent never gets access silently. While the answer
 * is still loading it says so (the host holds Create until it knows); when the
 * check failed it says that plainly rather than implying the agent gets
 * nothing; with nothing shared it renders nothing. It deliberately has no link:
 * leaving creation would throw the draft away, and the Activity entry recorded
 * when the agent arrives links to Connections.
 *
 * @param props - The arriving agent's name.
 */
export function EveryAgentAccessNotice({ agentName, className }: EveryAgentAccessNoticeProps) {
  const query = useEveryAgentConnectorGrants();
  const who = agentName.trim() || 'This agent';

  if (query.isPending) {
    return (
      <p
        className={cn('text-muted-foreground text-center text-xs', className)}
        data-testid="every-agent-access-checking"
      >
        Checking which apps every agent can use…
      </p>
    );
  }
  if (query.isError) {
    return (
      <p
        className={cn('text-muted-foreground text-xs', className)}
        data-testid="every-agent-access-unknown"
      >
        Couldn’t check which apps every agent can use. {who} gets whatever you gave every agent.
      </p>
    );
  }
  const grants = query.data?.connections ?? [];
  if (grants.length === 0) return null;

  const toolkitCounts = new Map<string, number>();
  for (const grant of grants) {
    toolkitCounts.set(grant.toolkit, (toolkitCounts.get(grant.toolkit) ?? 0) + 1);
  }
  const items = grants.map((grant) => {
    // Two accounts of one app are told apart by the person's own label.
    const name =
      (toolkitCounts.get(grant.toolkit) ?? 0) > 1
        ? `${serviceName(grant.toolkit)} · ${grant.label}`
        : serviceName(grant.toolkit);
    const level = accessLevelWords(grant.access.classifications);
    return `${name} (${grant.lifecycle === 'paused' ? `${level}, paused` : level})`;
  });

  return (
    <div
      className={cn('bg-muted/40 flex items-start gap-3 rounded-xl px-4 py-3 text-sm', className)}
      data-testid="every-agent-access-notice"
    >
      <Cable className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{who} will get:</span> {items.join(', ')}.{' '}
        <span className="text-muted-foreground">You can change this in Connections.</span>
      </p>
    </div>
  );
}
