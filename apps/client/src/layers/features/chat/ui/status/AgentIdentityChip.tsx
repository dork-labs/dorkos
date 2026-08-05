import { useStartNewSession } from '@/layers/entities/session';
import { useCallback } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { AgentIdentity } from '@/layers/entities/agent';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { AgentChipContextMenu } from './AgentChipContextMenu';

interface AgentIdentityChipProps {
  /** Agent display name (omit to hide the chip). */
  agentName?: string;
  /** Agent color (HSL or hex). */
  agentColor?: string;
  /** Agent emoji character. */
  agentEmoji?: string;
  /** Agent working directory path (enables the context menu actions). */
  agentPath?: string;
  /** Show the avatar alone — the narrowest tier of the line's width budget. */
  nameHidden?: boolean;
}

/**
 * Who you are talking to — the identity anchor of the status line's left cluster.
 *
 * Click opens the agent profile; right-click (long-press on touch) offers
 * switch agent / profile / new session. Renders nothing until name, color, and
 * emoji have all resolved, so the chip never flashes a half-formed identity.
 */
export function AgentIdentityChip({
  agentName,
  agentColor,
  agentEmoji,
  agentPath,
  nameHidden,
}: AgentIdentityChipProps) {
  const handleOpenProfile = useCallback(() => {
    if (!agentPath) return;
    useAgentHubStore.getState().openHub(agentPath);
    useAppStore.getState().setRightPanelOpen(true);
    useAppStore.getState().setActiveRightPanelTab('agent-hub');
  }, [agentPath]);

  const handleSwitchAgent = useCallback(() => {
    useAppStore.getState().openGlobalPaletteWithSearch('@');
  }, []);

  const startNewSession = useStartNewSession();
  const handleNewSession = useCallback(() => {
    startNewSession(agentPath ?? undefined);
  }, [startNewSession, agentPath]);

  if (!agentName || !agentColor || !agentEmoji) return null;

  return (
    <span className="inline-flex min-w-0 items-center">
      {agentPath ? (
        <AgentChipContextMenu
          onSwitchAgent={handleSwitchAgent}
          onOpenProfile={handleOpenProfile}
          onNewSession={handleNewSession}
        >
          {/* `max-w-full` is what makes the name truncate instead of overflowing.
              The context menu wraps the identity in a `display: block` span of
              Radix's own, so the identity is an inline-level box there rather than
              a flex item — and an inline box shrinks only to its min-content,
              which for a nowrap name is the whole name. It drew 22px past the box
              the row gave it, over the directory beside it (DOR-461). Capped at
              its container, the name's own `truncate` takes over. */}
          <AgentIdentity
            size="xs"
            name={agentName}
            color={agentColor}
            emoji={agentEmoji}
            nameHidden={nameHidden}
            onClick={handleOpenProfile}
            className="max-w-full"
          />
        </AgentChipContextMenu>
      ) : (
        <AgentIdentity
          size="xs"
          name={agentName}
          color={agentColor}
          emoji={agentEmoji}
          nameHidden={nameHidden}
          className="max-w-full"
        />
      )}
    </span>
  );
}
