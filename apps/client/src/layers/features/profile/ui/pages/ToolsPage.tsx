/**
 * MCP servers — the MCP servers this agent can reach (spec `profile-unification`
 * §1.5). The page was "Tools & MCP" until the tool-group switches it also carried
 * were replaced by the agent's Permissions page (spec `agent-permissions`); its
 * page id stays `tools`, so deep links that name it keep working.
 *
 * @module features/profile/ui/pages/ToolsPage
 */
import { Skeleton } from '@/layers/shared/ui';
import { AgentMcpServers } from '@/layers/features/agent-settings';
import { useProfileAgent } from '../../model/use-profile-agent';
import type { ProfilePageContentProps } from './types';

/** The agent's managed MCP servers. */
export function ToolsPage({ member }: ProfilePageContentProps) {
  const { agent, projectPath, isPending } = useProfileAgent(member);

  if (isPending) return <Skeleton className="h-32 w-full" />;
  if (!agent || projectPath === null) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this agent’s MCP servers.</p>;
  }

  return <AgentMcpServers agent={agent} projectPath={projectPath} />;
}
