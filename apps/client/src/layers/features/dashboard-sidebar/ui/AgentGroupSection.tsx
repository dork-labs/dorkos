import { useMemo, type ReactNode } from 'react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { SidebarGroup as SidebarGroupWrapper, SidebarMenu } from '@/layers/shared/ui';
import { useAgentsAggregateStatus } from '@/layers/entities/session';
import { GroupHeader } from './GroupHeader';
import { sortAgentPaths, type SortAgentsContext } from '../model/sort-agents';

interface AgentGroupSectionProps {
  /** The group to render. */
  group: SidebarGroup;
  /** Member paths filtered to the known roster, in the group's stored order. */
  memberPaths: string[];
  /** Display-name + activity lookups for the group's sort mode. */
  sortCtx: SortAgentsContext;
  /** Render one agent row. */
  renderRow: (path: string, keyPrefix: string) => ReactNode;
}

/**
 * One user-defined group: its {@link GroupHeader} plus member rows sorted by the
 * group's `sortMode`. When collapsed, rows are hidden and the header shows an
 * activity dot if any member is working. An empty group shows a quiet hint and
 * is never auto-deleted.
 */
export function AgentGroupSection({
  group,
  memberPaths,
  sortCtx,
  renderRow,
}: AgentGroupSectionProps) {
  const sortedPaths = useMemo(
    () => sortAgentPaths(memberPaths, group.sortMode, sortCtx),
    [memberPaths, group.sortMode, sortCtx]
  );

  // Single aggregated subscription across ALL member paths (incl. unknown ones,
  // which simply never match) — powers the collapsed-group activity dot.
  const hasActivity = useAgentsAggregateStatus(group.agentPaths);

  return (
    <SidebarGroupWrapper>
      <GroupHeader
        group={group}
        memberCount={memberPaths.length}
        showActivityDot={group.collapsed && hasActivity}
      />
      {!group.collapsed &&
        (sortedPaths.length > 0 ? (
          <SidebarMenu>{sortedPaths.map((path) => renderRow(path, group.id))}</SidebarMenu>
        ) : (
          <p className="text-muted-foreground/50 px-3 py-1.5 text-xs italic">Drag agents here</p>
        ))}
    </SidebarGroupWrapper>
  );
}
