/**
 * Tools & MCP — which tool groups this agent is told about, and which MCP
 * servers it can reach (spec `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/ToolsPage
 */
import { Skeleton } from '@/layers/shared/ui';
import { ToolsTab } from '@/layers/features/agent-settings';
import { useProfileAgent } from '../../model/use-profile-agent';
import type { ProfilePageContentProps } from './types';

/** The agent's tool groups and its managed MCP servers, on one page. */
export function ToolsPage({ member }: ProfilePageContentProps) {
  const { agent, projectPath, isPending } = useProfileAgent(member);

  if (isPending) return <Skeleton className="h-32 w-full" />;
  if (!agent || projectPath === null) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this agent’s tools.</p>;
  }

  // No `onUpdate`: every control on this page writes through the OPERATOR route
  // (`PATCH /api/mesh/agents/:id`), because every setting on it is one the agent
  // self-edit route refuses (DOR-1506). The page still reads through
  // `useProfileAgent`, which is what the tab renders from.
  return <ToolsTab agent={agent} projectPath={projectPath} />;
}
