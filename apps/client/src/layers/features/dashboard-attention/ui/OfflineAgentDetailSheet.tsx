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
import { AgentAvatar, useAgentVisual } from '@/layers/entities/agent';
import { formatCompactAge } from '@/layers/shared/lib';
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
      {/* `sm`, matching the other two-line member rows in a sheet
          (`RoomMemberRow`) rather than the one-line `xs` of a list row. */}
      <AgentAvatar color={visual.color} emoji={visual.emoji} size="sm" className="shrink-0" />
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
          {formatCompactAge(agent.lastSeenAt)} ago
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
  // Gated on `open`, like the run sheet beside it: this sheet is mounted on
  // every home render and closed almost always, and an ungated query polls the
  // whole mesh topology every 30s for a panel nobody opened.
  const { data: topology } = useTopology(undefined, open);

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
