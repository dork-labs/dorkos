import { useCallback } from 'react';
import { motion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import { Terminal, FileText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '@/layers/shared/model';
import { AgentIdentity } from '@/layers/entities/agent';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { AgentChipContextMenu } from './AgentChipContextMenu';

interface ShortcutChipsProps {
  onChipClick: (trigger: string) => void;
  /** Agent display name (omit to hide identity). */
  agentName?: string;
  /** Agent color (HSL or hex). */
  agentColor?: string;
  /** Agent emoji character. */
  agentEmoji?: string;
  /** Agent working directory path (enables context menu actions). */
  agentPath?: string;
}

interface ChipDef {
  trigger: string;
  label: string;
  icon: LucideIcon;
  ariaLabel: string;
}

const chips: ChipDef[] = [
  { trigger: '/', label: 'Commands', icon: Terminal, ariaLabel: 'Insert slash command trigger' },
  { trigger: '@', label: 'Files', icon: FileText, ariaLabel: 'Insert file mention trigger' },
];

/** Renders agent identity and trigger chips for slash commands and file mentions below the chat input. */
export function ShortcutChips({
  onChipClick,
  agentName,
  agentColor,
  agentEmoji,
  agentPath,
}: ShortcutChipsProps) {
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

  const showIdentity = agentName && agentColor && agentEmoji;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="mt-1.5 flex items-center justify-center gap-2 sm:justify-start"
    >
      {showIdentity &&
        (agentPath ? (
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
        ))}
      {chips.map((chip) => (
        <button
          key={chip.trigger}
          type="button"
          aria-label={chip.ariaLabel}
          onClick={() => onChipClick(chip.trigger)}
          className="bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-150"
        >
          <chip.icon className="size-3" />
          <kbd className="font-mono text-[10px] opacity-60">{chip.trigger}</kbd>
          {chip.label}
        </button>
      ))}
    </motion.div>
  );
}
