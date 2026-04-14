import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence, useAnimate } from 'motion/react';
import { Pencil } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Input } from '@/layers/shared/ui';
import {
  AgentAvatar,
  resolveAgentVisual,
  PresetPill,
  useNebulaAlpha,
} from '@/layers/entities/agent';
import { RightPanelHeader } from '@/layers/features/right-panel';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { useAgentHubContext } from '../model/agent-hub-context';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { findMatchingPreset, DEFAULT_PRESET_COLORS } from '../model/personality-presets';
import { AgentManagementMenu } from './AgentManagementMenu';
import { DeleteAgentDialog } from './DeleteAgentDialog';

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

/**
 * Stable references for the breathing animation.
 * Module-level to prevent Motion from restarting on re-render (reference equality).
 * Separated onto its own element (not the variant-driven wrapper) to avoid
 * `repeat: Infinity` cycling opacity back to the variant's `hidden` initial state.
 */
const BREATHING_ANIMATE = { scale: [1, 1.04, 1] };
const BREATHING_TRANSITION = { duration: 2, repeat: Infinity, ease: 'easeInOut' as const };

type AgentWithHealth = { healthStatus?: AgentHealthStatus };

function deriveStatus(agent: AgentWithHealth): { label: string; dotClass: string } {
  if (agent.healthStatus === 'active') {
    return { label: 'Online', dotClass: 'bg-emerald-500' };
  }
  return { label: 'Offline', dotClass: 'bg-muted-foreground/40' };
}

// ---------------------------------------------------------------------------
// Color Ripple Burst — expanding ring on color change
// ---------------------------------------------------------------------------

function ColorRipple({ color }: { color: string }) {
  return (
    <motion.span
      className="pointer-events-none absolute inset-0 rounded-full"
      style={{ border: `2px solid ${color}` }}
      initial={{ scale: 1, opacity: 0.6 }}
      animate={{ scale: 2.4, opacity: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
      aria-hidden
    />
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

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
  const { agent, onUpdate, previewColor, isPickerOpen, projectPath } = useAgentHubContext();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const visual = resolveAgentVisual(agent);
  // Use preview color when hovering swatches, fall back to committed color
  const displayColor = previewColor ?? visual.color;

  const agentWithHealth = agent as unknown as AgentWithHealth;
  const status = deriveStatus(agentWithHealth);
  const na = useNebulaAlpha();

  // Track previous color so the glow layer beneath can persist during crossfade.
  const previousColorRef = useRef(displayColor);
  const previousColor = previousColorRef.current;
  if (displayColor !== previousColor) {
    previousColorRef.current = displayColor;
  }

  // --- Squish-bounce on committed color/emoji change ---
  const [avatarScope, animateAvatar] = useAnimate();
  const prevCommittedRef = useRef({ color: visual.color, emoji: visual.emoji });

  useEffect(() => {
    const prev = prevCommittedRef.current;
    if (prev.color !== visual.color || prev.emoji !== visual.emoji) {
      prevCommittedRef.current = { color: visual.color, emoji: visual.emoji };
      animateAvatar(
        avatarScope.current,
        { scale: [1, 0.85, 1.08, 1], rotate: [0, -3, 1, 0] },
        { duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }
      );
    }
  }, [visual.color, visual.emoji, animateAvatar, avatarScope]);

  // --- Color ripple burst on committed color change ---
  const [rippleKey, setRippleKey] = useState(0);
  const prevRippleColorRef = useRef(visual.color);

  useEffect(() => {
    if (prevRippleColorRef.current !== visual.color) {
      prevRippleColorRef.current = visual.color;
      setRippleKey((k) => k + 1);
    }
  }, [visual.color]);

  const traits = agent.traits ?? DEFAULT_TRAITS;
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
            key={displayColor}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            style={{
              background: `radial-gradient(ellipse at 50% 40%, ${displayColor}${na.heroGlow} 0%, ${displayColor}${na.heroGlowOuter} 40%, transparent 70%)`,
            }}
          />
        </AnimatePresence>
      </div>

      {/* Shared panel header: segmented control + close */}
      <div className="relative z-10 w-full">
        <RightPanelHeader />
      </div>

      {/* Kebab menu — top-right corner */}
      <AgentManagementMenu
        className="absolute top-2 right-2 z-10"
        onDeleteRequest={() => setDeleteDialogOpen(true)}
      />

      {/* Avatar — clickable, opens appearance picker.
           Outer motion.div handles variant entrance (scaleIn with opacity).
           Inner motion.button handles breathing + squish (no variant conflict). */}
      <motion.div variants={scaleIn} className="relative z-[1]">
        <motion.button
          ref={avatarScope}
          type="button"
          className="group relative cursor-pointer"
          onClick={onAvatarClick}
          aria-label="Change agent color and icon"
          data-testid="avatar-picker-trigger"
          animate={isPickerOpen ? BREATHING_ANIMATE : undefined}
          transition={isPickerOpen ? BREATHING_TRANSITION : undefined}
        >
          <AgentAvatar
            color={displayColor}
            emoji={visual.emoji}
            size="lg"
            healthStatus={agentWithHealth.healthStatus}
          />

          {/* Color ripple burst */}
          <AnimatePresence>
            {rippleKey > 0 && <ColorRipple key={rippleKey} color={visual.color} />}
          </AnimatePresence>

          <span className="bg-background border-background absolute -right-0.5 -bottom-0.5 flex size-6 items-center justify-center rounded-full border-2 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
            <Pencil className="text-muted-foreground size-3" />
          </span>
        </motion.button>
      </motion.div>

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
      <motion.div variants={scaleIn}>
        <PresetPill
          emoji={activePreset?.emoji ?? '\u{2728}'}
          name={activePreset?.name ?? 'Custom'}
          colors={presetColors}
          active
          gradientText
          glow
          className="hover:bg-accent/80 relative z-[1] mt-1 cursor-pointer"
          onClick={onPersonalityClick}
          aria-label="Change personality"
          data-testid="personality-picker-trigger"
        />
      </motion.div>

      {/* Spacing before content */}
      <div className="h-2" />

      {/* Type-to-confirm delete dialog */}
      <DeleteAgentDialog
        agentId={agent.id}
        agentName={displayName}
        projectPath={projectPath}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
      />
    </motion.div>
  );
}
