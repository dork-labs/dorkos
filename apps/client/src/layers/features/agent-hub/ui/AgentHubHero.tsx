import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { Input } from '@/layers/shared/ui';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { RightPanelHeader } from '@/layers/features/right-panel';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { useAgentHubContext } from '../model/agent-hub-context';
import { findMatchingPreset, DEFAULT_PRESET_COLORS } from '../model/personality-presets';
import { useNebulaAlpha } from '../lib/nebula-theme';

/** Stagger orchestration for hero child elements. */
const heroVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
} as const;

const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
} as const;

const scaleIn = {
  hidden: { opacity: 0, scale: 0.85 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { type: 'spring', stiffness: 400, damping: 20 },
  },
} as const;

type AgentWithHealth = { healthStatus?: AgentHealthStatus };

function deriveStatus(agent: AgentWithHealth): { label: string; dotClass: string } {
  if (agent.healthStatus === 'active') {
    return { label: 'Online', dotClass: 'bg-emerald-500' };
  }
  return { label: 'Offline', dotClass: 'bg-muted-foreground/40' };
}

interface AgentHubHeroProps {
  onAvatarClick?: () => void;
  onPersonalityClick?: () => void;
}

/**
 * Immersive hero header for the Agent Hub panel.
 *
 * Top row uses the shared RightPanelHeader for panel tab switching and close.
 * Below: clickable avatar, inline-editable name, status, and clickable
 * personality badge.
 */
export function AgentHubHero({ onAvatarClick, onPersonalityClick }: AgentHubHeroProps) {
  const { agent, onUpdate } = useAgentHubContext();

  const visual = resolveAgentVisual(agent);
  const agentWithHealth = agent as unknown as AgentWithHealth;
  const status = deriveStatus(agentWithHealth);
  const na = useNebulaAlpha();

  // Track previous color so the glow layer beneath can persist during crossfade.
  const previousColorRef = useRef(visual.color);
  const previousColor = previousColorRef.current;
  if (visual.color !== previousColor) {
    // Update ref after render so next render uses the new color as "previous".
    previousColorRef.current = visual.color;
  }

  const traits = agent.traits ?? {
    tone: 3,
    autonomy: 3,
    caution: 3,
    communication: 3,
    creativity: 3,
  };
  const activePreset = findMatchingPreset(traits);
  const presetColors = activePreset?.colors ?? DEFAULT_PRESET_COLORS;

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');

  const displayName = agent.displayName ?? agent.name;

  const startNameEdit = useCallback(() => {
    setNameValue(displayName);
    setEditingName(true);
  }, [displayName]);

  const commitNameEdit = useCallback(() => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== displayName) {
      onUpdate({ displayName: trimmed });
    }
    setEditingName(false);
  }, [nameValue, displayName, onUpdate]);

  return (
    <motion.div
      data-slot="agent-hub-hero"
      className="relative flex flex-col items-center gap-1 border-b pb-0"
      style={{ overflow: 'hidden' }}
      variants={heroVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Nebula ambient glow — crossfades between agent colors */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {/* Previous color as stable base layer */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at 50% 40%, ${previousColor}${na.heroGlow} 0%, ${previousColor}${na.heroGlowOuter} 40%, transparent 70%)`,
          }}
        />
        {/* New color fades in on top */}
        <AnimatePresence mode="sync">
          <motion.div
            key={visual.color}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            style={{
              background: `radial-gradient(ellipse at 50% 40%, ${visual.color}${na.heroGlow} 0%, ${visual.color}${na.heroGlowOuter} 40%, transparent 70%)`,
            }}
          />
        </AnimatePresence>
      </div>

      {/* Shared panel header: segmented control + close */}
      <div className="relative z-10 w-full">
        <RightPanelHeader />
      </div>

      {/* Avatar — clickable, opens appearance picker */}
      <motion.button
        type="button"
        className="group relative z-[1] cursor-pointer"
        onClick={onAvatarClick}
        aria-label="Change agent color and icon"
        data-testid="avatar-picker-trigger"
        variants={scaleIn}
      >
        <AgentAvatar
          color={visual.color}
          emoji={visual.emoji}
          size="lg"
          healthStatus={agentWithHealth.healthStatus}
        />
        <span className="bg-background/60 absolute inset-0 flex items-center justify-center rounded-full text-[10px] opacity-0 transition-opacity group-hover:opacity-100">
          &#9998;
        </span>
      </motion.button>

      {/* Inline-editable name */}
      <motion.div className="relative z-[1] mt-1" variants={fadeUp}>
        {editingName ? (
          <Input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitNameEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNameEdit();
              if (e.key === 'Escape') setEditingName(false);
            }}
            className="h-7 w-40 text-center text-[15px] font-semibold"
            data-testid="name-input"
          />
        ) : (
          <button
            type="button"
            onClick={startNameEdit}
            className={cn(
              'text-[15px] font-semibold transition-colors',
              'hover:text-muted-foreground cursor-text'
            )}
            data-testid="agent-name"
          >
            {displayName}
          </button>
        )}
      </motion.div>

      {/* Status indicator */}
      <motion.div
        className="text-muted-foreground relative z-[1] flex items-center gap-1.5 text-[10px]"
        variants={fadeUp}
      >
        <span className={cn('size-1.5 rounded-full', status.dotClass)} />
        <span>{status.label}</span>
      </motion.div>

      {/* Personality badge — clickable, opens personality picker */}
      <motion.button
        type="button"
        className="hover:bg-accent/80 relative z-[1] mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all"
        style={{
          borderColor: presetColors.stroke + na.pillBorder,
          background: `linear-gradient(135deg, ${presetColors.nebula}${na.pillBgStart}, ${presetColors.wisp}${na.pillBgEnd})`,
        }}
        onClick={onPersonalityClick}
        aria-label="Change personality"
        data-testid="personality-picker-trigger"
        variants={scaleIn}
      >
        <span>{activePreset?.emoji ?? '\u{2728}'}</span>
        <span
          className="bg-clip-text text-transparent"
          style={{
            backgroundImage: `linear-gradient(135deg, ${presetColors.stroke}, ${presetColors.strokeEnd})`,
          }}
        >
          {activePreset?.name ?? 'Custom'}
        </span>
      </motion.button>

      {/* Spacing before content */}
      <div className="h-2" />
    </motion.div>
  );
}
