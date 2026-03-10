import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '@/layers/shared/model';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentVisual } from '@/layers/entities/agent';

interface AgentIdentityChipProps {
  /** Current agent manifest, null when no agent registered */
  agent: AgentManifest | null | undefined;
  /** Derived visual identity (color + emoji) */
  visual: AgentVisual;
  /** Whether the agent is currently streaming a response */
  isStreaming: boolean;
}

/**
 * Clickable agent identity chip for the top navigation bar.
 *
 * Shows the active agent's color dot + name, or a muted "No agent" fallback.
 * Clicking opens the agent settings dialog. The color dot pulses during streaming.
 * Agent name transitions with a slide animation when switching agents.
 */
export function AgentIdentityChip({ agent, visual, isStreaming }: AgentIdentityChipProps) {
  const openGlobalPaletteWithSearch = useAppStore((s) => s.openGlobalPaletteWithSearch);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          onClick={() => openGlobalPaletteWithSearch('@')}
          className="hover:bg-accent flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors"
          whileTap={{ scale: 0.97 }}
          aria-label={
            agent
              ? `${agent.name} \u2014 switch agent`
              : 'Switch agent'
          }
        >
          {/* Color dot — solid when agent exists, dashed border when no agent */}
          {agent ? (
            <motion.span
              className="size-2 shrink-0 rounded-full"
              animate={{
                backgroundColor: visual.color,
                opacity: isStreaming ? [1, 0.4, 1] : 1,
              }}
              transition={
                isStreaming
                  ? { duration: 1.5, repeat: Infinity, ease: 'easeInOut' }
                  : { duration: 0.3, ease: 'easeOut' }
              }
              aria-hidden
            />
          ) : (
            <span
              className="border-muted-foreground/40 size-2 shrink-0 rounded-full border border-dashed"
              aria-hidden
            />
          )}

          {/* Agent emoji + name with slide transition on agent switch */}
          <AnimatePresence mode="wait">
            <motion.span
              key={agent?.id ?? 'no-agent'}
              className={`flex items-center gap-1 max-w-[160px] text-sm ${
                agent ? 'font-medium' : 'text-muted-foreground'
              }`}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 3 }}
              transition={{ duration: 0.12 }}
            >
              {agent && visual.emoji && (
                <span className="text-xs leading-none">{visual.emoji}</span>
              )}
              <span className="truncate">{agent?.name ?? 'No agent'}</span>
            </motion.span>
          </AnimatePresence>

          <ChevronDown className="text-muted-foreground size-3" aria-hidden />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Agent settings</TooltipContent>
    </Tooltip>
  );
}
