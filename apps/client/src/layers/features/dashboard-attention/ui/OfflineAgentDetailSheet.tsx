import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  Badge,
  Button,
  ScrollArea,
} from '@/layers/shared/ui';
import { useTopology } from '@/layers/entities/mesh';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useAgentVisual } from '@/layers/entities/agent';
import { formatRelativeTime } from '../lib/format-relative-time';
import { Check } from 'lucide-react';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { useMemo } from 'react';

interface OfflineAgentDetailSheetProps {
  open: boolean;
  onClose: () => void;
}

interface AgentRowProps {
  agent: TopologyAgent;
}

/** Single offline agent row with visual identity, status, and last seen time. */
function AgentRow({ agent }: AgentRowProps) {
  const visual = useAgentVisual(agent, agent.projectPath ?? '');

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-lg" aria-hidden>
        {visual.emoji}
      </span>
      <div className="size-2 shrink-0 rounded-full" style={{ backgroundColor: visual.color }} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{getAgentDisplayName(agent)}</p>
        <div className="flex items-center gap-2">
          <Badge variant="destructive" className="text-xs">
            Unreachable
          </Badge>
          {agent.runtime && (
            <Badge variant="secondary" className="text-xs">
              {agent.runtime}
            </Badge>
          )}
        </div>
      </div>
      {agent.lastSeenAt && (
        <span className="text-muted-foreground shrink-0 text-xs">
          {formatRelativeTime(agent.lastSeenAt)} ago
        </span>
      )}
    </div>
  );
}

/**
 * Detail sheet listing all offline/unreachable mesh agents with their
 * visual identity, status badges, runtime info, and last-seen timestamps.
 */
export function OfflineAgentDetailSheet({ open, onClose }: OfflineAgentDetailSheetProps) {
  const { data: topology } = useTopology();

  // Flatten all agents from all namespaces and filter to unreachable
  const offlineAgents = useMemo(() => {
    if (!topology) return [];
    return topology.namespaces
      .flatMap((ns) => ns.agents)
      .filter((a) => a.healthStatus === 'unreachable');
  }, [topology]);

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Offline Agents</SheetTitle>
          <SheetDescription>
            {offlineAgents.length} agent{offlineAgents.length === 1 ? '' : 's'} unreachable
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4">
          {offlineAgents.length > 0 ? (
            <div className="divide-y">
              {offlineAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-8">
              <Check className="size-6 text-green-500" />
              <p className="text-muted-foreground text-sm">All agents are online</p>
            </div>
          )}
        </ScrollArea>

        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
