import type { ComponentProps, ReactNode } from 'react';
import { Check, Wand2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn, COLOR_PRESETS, EMOJI_SET } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';

/** Stagger orchestration shared by both grids' entrance animation. */
const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
} as const;

const popIn = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { type: 'spring', stiffness: 500, damping: 25 },
  },
} as const;

/** Momentary checkmark burst shown over a swatch or emoji right after it's picked. */
function SelectionCheck() {
  return (
    <motion.span
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
      initial={{ scale: 0, opacity: 1 }}
      animate={{ scale: 1, opacity: 0 }}
      transition={{ duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
      aria-hidden
    >
      <Check className="size-4 text-white drop-shadow-md" strokeWidth={3} />
    </motion.span>
  );
}

// ---------------------------------------------------------------------------
// AvatarColorGrid
// ---------------------------------------------------------------------------

export interface AvatarColorGridProps {
  /** Currently applied color override; `null`/`undefined` selects the auto-derived default. */
  value: string | null | undefined;
  /** The deterministic color the auto swatch shows (and applies when picked). */
  autoColor: string;
  /** Called with a preset's hex, or `null` for the auto swatch. */
  onSelect: (hex: string | null) => void;
  /** Live-preview hover, e.g. tinting a hero avatar while browsing swatches. Omit to skip. */
  onHoverChange?: (hex: string | null) => void;
  /** `'auto'` or a preset's hex right after it was picked — renders the momentary checkmark. Omit to skip the celebration. */
  justSelectedKey?: string | null;
}

/**
 * The color-swatch row shared by every avatar color picker: the
 * auto-derived default plus the fixed {@link COLOR_PRESETS} palette. Was
 * duplicated near-verbatim between `IdentityTab` and `AvatarPickerPopover`
 * before DOR-970 collapsed it to one implementation; the two surfaces keep
 * their own chrome (a settings-form popover vs. a celebratory inline panel)
 * and opt into hover-preview / selection-burst via props.
 */
export function AvatarColorGrid({
  value,
  autoColor,
  onSelect,
  onHoverChange,
  justSelectedKey,
}: AvatarColorGridProps) {
  const hasOverride = value != null;

  return (
    <motion.div
      className="flex flex-wrap items-center gap-2"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={popIn}>
        <ColorSwatch
          active={!hasOverride}
          activeRing="ring-muted-foreground/50 ring-2 ring-offset-2"
          color={autoColor}
          label="Select unique auto-generated color"
          tooltip="Unique — derived from agent name"
          onClick={() => onSelect(null)}
          onHoverChange={onHoverChange}
          justSelected={justSelectedKey === 'auto'}
        >
          <Wand2 className="size-3" />
        </ColorSwatch>
      </motion.div>

      <div className="bg-border mx-0.5 h-5 w-px" />

      {COLOR_PRESETS.map((preset) => (
        <motion.div key={preset.hex} variants={popIn}>
          <ColorSwatch
            active={value === preset.hex}
            activeRing="ring-foreground ring-2 ring-offset-2"
            color={preset.hex}
            label={`Select ${preset.name}`}
            tooltip={preset.name}
            onClick={() => onSelect(preset.hex)}
            onHoverChange={onHoverChange}
            justSelected={justSelectedKey === preset.hex}
          />
        </motion.div>
      ))}
    </motion.div>
  );
}

interface ColorSwatchProps {
  active: boolean;
  activeRing: string;
  color: string;
  label: string;
  tooltip: string;
  tooltipSide?: ComponentProps<typeof TooltipContent>['side'];
  onClick: () => void;
  onHoverChange?: (hex: string | null) => void;
  justSelected: boolean;
  children?: ReactNode;
}

function ColorSwatch({
  active,
  activeRing,
  color,
  label,
  tooltip,
  tooltipSide = 'bottom',
  onClick,
  onHoverChange,
  justSelected,
  children,
}: ColorSwatchProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          onMouseEnter={() => onHoverChange?.(color)}
          onMouseLeave={() => onHoverChange?.(null)}
          className={cn(
            'group/swatch relative size-8 rounded-full transition-all duration-150',
            active ? activeRing : 'hover:scale-110'
          )}
          style={{ backgroundColor: color }}
          aria-label={label}
        >
          {children && (
            <span className="bg-background/80 text-foreground absolute inset-0 flex items-center justify-center rounded-full">
              {children}
            </span>
          )}
          <span
            className="absolute inset-[-4px] -z-10 rounded-full opacity-0 blur-md transition-opacity duration-200 group-hover/swatch:opacity-50"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <AnimatePresence>{justSelected && <SelectionCheck />}</AnimatePresence>
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} className="text-[10px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// AvatarEmojiGrid
// ---------------------------------------------------------------------------

export interface AvatarEmojiGridProps {
  /** The emoji shown as active — the override if set, otherwise `autoEmoji`. */
  value: string;
  /** The deterministic emoji auto-derived for this agent. */
  autoEmoji: string;
  /** True when `value` is an explicit override rather than the auto default. */
  hasOverride: boolean;
  onSelect: (emoji: string) => void;
  /** The emoji key (`emoji-<char>`) right after it was picked — renders the momentary checkmark. Omit to skip the celebration. */
  justSelectedKey?: string | null;
}

/**
 * The emoji grid shared by every avatar icon picker, over the fixed
 * {@link EMOJI_SET}. See {@link AvatarColorGrid} for the collapse rationale.
 */
export function AvatarEmojiGrid({
  value,
  autoEmoji,
  hasOverride,
  onSelect,
  justSelectedKey,
}: AvatarEmojiGridProps) {
  return (
    <motion.div
      className="grid grid-cols-6 gap-1.5"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {EMOJI_SET.map((emoji) => {
        const isActive = emoji === value;
        const isAutoDefault = emoji === autoEmoji && !hasOverride;
        return (
          <motion.button
            key={emoji}
            type="button"
            onClick={() => onSelect(emoji)}
            className={cn(
              'relative flex size-9 items-center justify-center rounded-md text-lg transition-colors duration-150',
              isActive
                ? isAutoDefault
                  ? 'bg-accent ring-muted-foreground/50 ring-1'
                  : 'bg-accent ring-foreground ring-1'
                : 'hover:bg-accent/50 active:scale-90'
            )}
            aria-label={`Select icon ${emoji}`}
            variants={popIn}
            whileHover={{ scale: 1.25 }}
            whileTap={{ scale: 0.85 }}
            transition={{ type: 'spring', stiffness: 500, damping: 20 }}
          >
            {emoji}
            <AnimatePresence>
              {justSelectedKey === `emoji-${emoji}` && <SelectionCheck />}
            </AnimatePresence>
          </motion.button>
        );
      })}
    </motion.div>
  );
}
