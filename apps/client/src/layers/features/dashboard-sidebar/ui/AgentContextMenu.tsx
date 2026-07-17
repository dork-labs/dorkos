import type { ReactNode } from 'react';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from '@/layers/shared/ui';
import { AgentRowMenuItems } from './AgentRowMenuItems';

interface AgentContextMenuProps {
  children: ReactNode;
  /** Agent projectPath the menu acts on. */
  path: string;
  /** Open the agent's profile in the right-panel hub. */
  onOpenProfile: () => void;
  /** Start a new session for this agent. */
  onNewSession: () => void;
  /** Open the inline group-create flow, moving this agent into the new group on commit. */
  onRequestNewGroup: (agentPath: string) => void;
}

/**
 * Right-click / long-press context menu for agent rows.
 *
 * Wraps children in a Radix ContextMenu trigger (desktop right-click, mobile
 * long-press) and renders the shared {@link AgentRowMenuItems} so its items stay
 * identical to the "…" dropdown on {@link AgentListItem}.
 */
export function AgentContextMenu({
  children,
  path,
  onOpenProfile,
  onNewSession,
  onRequestNewGroup,
}: AgentContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <AgentRowMenuItems
          variant="context"
          path={path}
          onOpenProfile={onOpenProfile}
          onNewSession={onNewSession}
          onRequestNewGroup={onRequestNewGroup}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
