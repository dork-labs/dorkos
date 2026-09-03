import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Wand2 } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { seedAgentFace } from '@dorkos/shared/agent-face';
import { Button } from '@/layers/shared/ui';
import { AvatarColorGrid, AvatarEmojiGrid } from './AvatarPickerGrid';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** This panel's richer auto-swatch presentation — a solid ring and the Wand2 glyph, in place of `AvatarColorGrid`'s plain-container defaults (a dashed ring and an "A" glyph). */
const AUTO_SWATCH_ICON = <Wand2 className="size-3" />;
const AUTO_SWATCH_ACTIVE_RING = 'ring-muted-foreground/50 ring-2 ring-offset-2';
const AUTO_SWATCH_LABEL = 'Select unique auto-generated color';

const FIRST_CUSTOMIZATION_KEY = 'dorkos:avatar-first-customization';

/** Stagger orchestration for picker sections. */
const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
} as const;

const fadeIn = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
} as const;

// ---------------------------------------------------------------------------
// Sparkle burst — first-customization celebration
// ---------------------------------------------------------------------------

function SparkleBurst() {
  // A lazy `useState` initializer, not a memo: the burst is randomised once per
  // mount and never recomputed, and render itself may not roll dice.
  const [particles] = useState(() => {
    const count = 14;
    return Array.from({ length: count }, (_, i) => {
      const angle = (Math.PI * 2 * i) / count;
      const dist = 28 + Math.random() * 20;
      const hue = (360 * i) / count;
      return {
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        size: 3 + Math.random() * 3,
        hue,
        delay: i * 0.02,
      };
    });
  });

  return (
    <div className="pointer-events-none absolute inset-0 z-50 overflow-visible" aria-hidden>
      {particles.map((p, i) => (
        <motion.span
          key={i}
          className="absolute top-1/2 left-1/2 rounded-full"
          style={{
            width: p.size,
            height: p.size,
            background: `hsl(${p.hue}, 80%, 70%)`,
            boxShadow: `0 0 6px hsl(${p.hue}, 80%, 70%)`,
          }}
          initial={{ x: '-50%', y: '-50%', scale: 0, opacity: 1 }}
          animate={{ x: p.x, y: p.y, scale: 1, opacity: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut', delay: p.delay }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AvatarPickerPanel
// ---------------------------------------------------------------------------

export interface AvatarPickerPanelProps {
  /** The agent whose face is being chosen. */
  agent: AgentManifest;
  /** Persist a manifest change. `null` on `color`/`icon` means "back to auto". */
  onUpdate: (updates: Partial<AgentManifest>) => void;
  /** Show a colour under the pointer without saving it. */
  onPreviewColor: (color: string | null) => void;
  /**
   * The panel's own heading, when the surface around it has none. The profile's
   * Appearance page draws its own title, so it passes nothing.
   */
  title?: string;
  /**
   * Dismiss the panel. Omitted where the surface around it owns the way out —
   * the profile's pushed page has a back link, and a second X beside it would
   * be two exits from one screen.
   */
  onClose?: () => void;
}

/**
 * Pick an agent's colour and emoji — the two halves of its face.
 *
 * Entity UI rather than a feature's: it is a manifest in, a patch out, with no
 * idea which surface is drawing it. Today that is the profile's Appearance
 * page; keeping the picker here is what lets a second surface draw it without
 * a second implementation.
 */
export function AvatarPickerPanel({
  agent,
  onUpdate,
  onPreviewColor,
  title,
  onClose,
}: AvatarPickerPanelProps) {
  // The face DorkOS seeds for this agent — see IdentityTab (DOR-949).
  const auto = useMemo(() => seedAgentFace(agent.id), [agent.id]);
  const autoColor = auto.color;
  const autoEmoji = auto.icon;
  const activeEmoji = agent.icon ?? autoEmoji;
  const hasColorOverride = agent.color != null;
  const hasIconOverride = agent.icon != null;
  const hasAnyOverride = hasColorOverride || hasIconOverride;

  // Track which swatch was just selected for the checkmark animation
  const [justSelected, setJustSelected] = useState<string | null>(null);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // First-customization sparkle
  const [showSparkle, setShowSparkle] = useState(false);
  const hasCustomizedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    };
  }, []);

  const triggerFirstCustomization = useCallback(() => {
    if (hasCustomizedRef.current) return;
    try {
      if (localStorage.getItem(FIRST_CUSTOMIZATION_KEY)) return;
      localStorage.setItem(FIRST_CUSTOMIZATION_KEY, 'true');
    } catch {
      return;
    }
    hasCustomizedRef.current = true;
    setShowSparkle(true);
    setTimeout(() => setShowSparkle(false), 800);
  }, []);

  const showCheckmark = useCallback((key: string) => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    setJustSelected(key);
    checkTimerRef.current = setTimeout(() => setJustSelected(null), 600);
  }, []);

  const handleResetDefaults = useCallback(() => {
    onUpdate({ color: null, icon: null } as unknown as Partial<AgentManifest>);
  }, [onUpdate]);

  const handleColorSelect = useCallback(
    (hex: string | null) => {
      onUpdate({ color: hex } as unknown as Partial<AgentManifest>);
      onPreviewColor(null);
      showCheckmark(hex ?? 'auto');
      triggerFirstCustomization();
    },
    [onUpdate, onPreviewColor, showCheckmark, triggerFirstCustomization]
  );

  const handleIconSelect = useCallback(
    (emoji: string) => {
      const value = emoji === autoEmoji ? null : emoji;
      onUpdate({ icon: value } as unknown as Partial<AgentManifest>);
      showCheckmark(`emoji-${emoji}`);
      triggerFirstCustomization();
    },
    [onUpdate, autoEmoji, showCheckmark, triggerFirstCustomization]
  );

  const handleColorHover = useCallback(
    (hex: string | null) => {
      onPreviewColor(hex);
    },
    [onPreviewColor]
  );

  return (
    <div className="flex flex-1 flex-col overflow-auto" data-testid="avatar-picker-panel">
      {/* The row exists for whatever it has to carry: a title where the surface
          has none, a way out where the surface offers none, and the reset only
          once there is something to reset. With none of the three there is no
          row — the profile's page draws its own title and back link. */}
      {(title || onClose || hasAnyOverride) && (
        <div
          className={cn(
            'flex items-center justify-between px-4 py-2',
            (title || onClose) && 'border-b'
          )}
        >
          {title && <span className="text-xs font-semibold">{title}</span>}
          <div className="ml-auto flex items-center gap-1">
            <AnimatePresence>
              {hasAnyOverride && (
                <motion.button
                  type="button"
                  onClick={handleResetDefaults}
                  className="text-muted-foreground hover:text-foreground text-3xs transition-colors"
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.2 }}
                >
                  Reset to defaults
                </motion.button>
              )}
            </AnimatePresence>
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={onClose}
                aria-label="Close appearance picker"
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      <motion.div
        className="space-y-5 p-4"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Color swatches */}
        <motion.div variants={fadeIn}>
          <div className="text-muted-foreground mb-2 text-3xs font-medium tracking-wider uppercase">
            Color
          </div>
          <AvatarColorGrid
            value={agent.color}
            autoColor={autoColor}
            onSelect={handleColorSelect}
            onHoverChange={handleColorHover}
            justSelectedKey={justSelected}
            celebratory
            autoIcon={AUTO_SWATCH_ICON}
            autoActiveRing={AUTO_SWATCH_ACTIVE_RING}
            autoLabel={AUTO_SWATCH_LABEL}
          />
        </motion.div>

        {/* Emoji grid */}
        <motion.div variants={fadeIn}>
          <div className="text-muted-foreground mb-2 text-3xs font-medium tracking-wider uppercase">
            Icon
          </div>
          <AvatarEmojiGrid
            value={activeEmoji}
            autoEmoji={autoEmoji}
            hasOverride={hasIconOverride}
            onSelect={handleIconSelect}
            justSelectedKey={justSelected}
            celebratory
          />
        </motion.div>
      </motion.div>

      {/* First-customization sparkle */}
      <AnimatePresence>{showSparkle && <SparkleBurst />}</AnimatePresence>
    </div>
  );
}
