import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { AvatarColorGrid, AvatarEmojiGrid } from '@/layers/entities/agent';
import { useAgentHubContext } from '../model/agent-hub-context';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

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
  const particles = useMemo(() => {
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
  }, []);

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

interface AvatarPickerPanelProps {
  onClose: () => void;
}

/**
 * Full-width inline panel for picking agent color and emoji icon.
 * Rendered in the tab content area when the avatar is clicked.
 */
export function AvatarPickerPanel({ onClose }: AvatarPickerPanelProps) {
  const { agent, onUpdate, onPreviewColor } = useAgentHubContext();

  const autoColor = useMemo(() => hashToHslColor(agent.id), [agent.id]);
  const autoEmoji = useMemo(() => hashToEmoji(agent.id), [agent.id]);
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
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-xs font-semibold">Appearance</span>
        <div className="flex items-center gap-1">
          <AnimatePresence>
            {hasAnyOverride && (
              <motion.button
                type="button"
                onClick={handleResetDefaults}
                className="text-muted-foreground hover:text-foreground text-[10px] transition-colors"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.2 }}
              >
                Reset to defaults
              </motion.button>
            )}
          </AnimatePresence>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onClose}
            aria-label="Close appearance picker"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <motion.div
        className="space-y-5 p-4"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Color swatches */}
        <motion.div variants={fadeIn}>
          <div className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wider uppercase">
            Color
          </div>
          <AvatarColorGrid
            value={agent.color}
            autoColor={autoColor}
            onSelect={handleColorSelect}
            onHoverChange={handleColorHover}
            justSelectedKey={justSelected}
          />
        </motion.div>

        {/* Emoji grid */}
        <motion.div variants={fadeIn}>
          <div className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wider uppercase">
            Icon
          </div>
          <AvatarEmojiGrid
            value={activeEmoji}
            autoEmoji={autoEmoji}
            hasOverride={hasIconOverride}
            onSelect={handleIconSelect}
            justSelectedKey={justSelected}
          />
        </motion.div>
      </motion.div>

      {/* First-customization sparkle */}
      <AnimatePresence>{showSparkle && <SparkleBurst />}</AnimatePresence>
    </div>
  );
}
