import { useCallback } from 'react';
import { motion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
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
}

/**
 * Who you are talking to, shown below the composer.
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
}: AgentIdentityChipProps) {
  const navigate = useNavigate();

  const handleOpenProfile = useCallback(() => {
    if (!agentPath) return;
    useAgentHubStore.getState().openHub(agentPath);
    useAppStore.getState().setRightPanelOpen(true);
    useAppStore.getState().setActiveRightPanelTab('agent-hub');
  }, [agentPath]);

  const handleSwitchAgent = useCallback(() => {
    useAppStore.getState().openGlobalPaletteWithSearch('@');
  }, []);

  const handleNewSession = useCallback(() => {
    navigate({
      to: '/session',
      search: { dir: agentPath ?? undefined, session: crypto.randomUUID() },
    });
  }, [navigate, agentPath]);

  if (!agentName || !agentColor || !agentEmoji) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="mt-1.5 flex items-center gap-2"
    >
      {agentPath ? (
        <AgentChipContextMenu
          onSwitchAgent={handleSwitchAgent}
          onOpenProfile={handleOpenProfile}
          onNewSession={handleNewSession}
        >
          <AgentIdentity
            size="xs"
            name={agentName}
            color={agentColor}
            emoji={agentEmoji}
            onClick={handleOpenProfile}
          />
        </AgentChipContextMenu>
      ) : (
        <AgentIdentity size="xs" name={agentName} color={agentColor} emoji={agentEmoji} />
      )}
    </motion.div>
  );
}
