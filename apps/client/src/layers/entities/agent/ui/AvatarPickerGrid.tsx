import type { ComponentProps, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn, COLOR_PRESETS, EMOJI_SET } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';

/** Stagger orchestration for the celebratory grids' entrance animation. */
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

/**
 * Wraps `children` in the entrance-stagger container when `celebratory`;
 * otherwise a plain `div` with the same className. Shared by both grids so
 * the animated/plain branch lives in exactly one place.
 */
function StaggerRoot({
  celebratory,
  className,
  children,
}: {
  celebratory: boolean;
  className: string;
  children: ReactNode;
}) {
  if (!celebratory) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {children}
    </motion.div>
  );
}

/** Wraps one grid item in the pop-in entrance animation when `celebratory`; a no-op otherwise. */
function StaggerItem({ celebratory, children }: { celebratory: boolean; children: ReactNode }) {
  if (!celebratory) return children;
  return <motion.div variants={popIn}>{children}</motion.div>;
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
  /** `'auto'` or a preset's hex right after it was picked — renders the momentary checkmark. Omit to skip. */
  justSelectedKey?: string | null;
  /**
   * Enables `AvatarPickerPanel`'s celebratory chrome — staggered entrance,
   * per-swatch tooltips, and a hover glow. Defaults to `false`: the plain,
   * static grid `IdentityTab`'s settings-form popover uses. Behavior
   * preservation is this branch's contract (DOR-970) — collapsing the two
   * grids into one component must not hand either container chrome it
   * didn't have before.
   */
  celebratory?: boolean;
  /** Content rendered inside the auto-derived swatch. Defaults to a bold "A" glyph — `IdentityTab`'s convention. */
  autoIcon?: ReactNode;
  /** Ring classes applied to the auto swatch when it's the active selection. Defaults to `IdentityTab`'s dashed ring. */
  autoActiveRing?: string;
  /** Accessible label for the auto swatch. Defaults to `IdentityTab`'s "Select default color". */
  autoLabel?: string;
}

const DEFAULT_AUTO_ICON = <span className="text-[9px] leading-none font-bold">A</span>;
const DEFAULT_AUTO_ACTIVE_RING = 'ring-muted-foreground/50 ring-dashed ring-2 ring-offset-2';
const DEFAULT_AUTO_LABEL = 'Select default color';

/**
 * The color-swatch row shared by every avatar color picker: the
 * auto-derived default plus the fixed {@link COLOR_PRESETS} palette. Was
 * duplicated near-verbatim between `IdentityTab` and `AvatarPickerPanel`
 * before DOR-970 collapsed it to one implementation. `celebratory` gates
 * every piece of chrome that differed between the two originals; layout,
 * selection-ring logic and sizing are identical either way.
 */
export function AvatarColorGrid({
  value,
  autoColor,
  onSelect,
  onHoverChange,
  justSelectedKey,
  celebratory = false,
  autoIcon = DEFAULT_AUTO_ICON,
  autoActiveRing = DEFAULT_AUTO_ACTIVE_RING,
  autoLabel = DEFAULT_AUTO_LABEL,
}: AvatarColorGridProps) {
  const hasOverride = value != null;

  return (
    <StaggerRoot celebratory={celebratory} className="flex flex-wrap items-center gap-2">
      <StaggerItem celebratory={celebratory}>
        <ColorSwatch
          active={!hasOverride}
          activeRing={autoActiveRing}
          color={autoColor}
          label={autoLabel}
          tooltip="Unique — derived from agent name"
          onClick={() => onSelect(null)}
          onHoverChange={onHoverChange}
          justSelected={justSelectedKey === 'auto'}
          celebratory={celebratory}
        >
          {autoIcon}
        </ColorSwatch>
      </StaggerItem>

      <div className="bg-border mx-0.5 h-5 w-px" />

      {COLOR_PRESETS.map((preset) => (
        <StaggerItem key={preset.hex} celebratory={celebratory}>
          <ColorSwatch
            active={value === preset.hex}
            activeRing="ring-foreground ring-2 ring-offset-2"
            color={preset.hex}
            label={`Select ${preset.name}`}
            tooltip={preset.name}
            onClick={() => onSelect(preset.hex)}
            onHoverChange={onHoverChange}
            justSelected={justSelectedKey === preset.hex}
            celebratory={celebratory}
          />
        </StaggerItem>
      ))}
    </StaggerRoot>
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
  /** Wraps the swatch in a `Tooltip` and renders its hover glow. See {@link AvatarColorGridProps.celebratory}. */
  celebratory: boolean;
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
  celebratory,
  children,
}: ColorSwatchProps) {
  const button = (
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
      {celebratory && (
        <span
          className="absolute inset-[-4px] -z-10 rounded-full opacity-0 blur-md transition-opacity duration-200 group-hover/swatch:opacity-50"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      <AnimatePresence>{justSelected && <SelectionCheck />}</AnimatePresence>
    </button>
  );

  if (!celebratory) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
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
  /** Called with the emoji the operator clicked. */
  onSelect: (emoji: string) => void;
  /** The emoji key (`emoji-<char>`) right after it was picked — renders the momentary checkmark. Omit to skip. */
  justSelectedKey?: string | null;
  /**
   * Enables `AvatarPickerPanel`'s celebratory chrome — staggered entrance
   * and hover/tap scale. Defaults to `false`: the plain grid `IdentityTab`
   * uses. See {@link AvatarColorGridProps.celebratory}.
   */
  celebratory?: boolean;
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
  celebratory = false,
}: AvatarEmojiGridProps) {
  return (
    <StaggerRoot celebratory={celebratory} className="grid grid-cols-6 gap-1.5">
      {EMOJI_SET.map((emoji) => {
        const isActive = emoji === value;
        const isAutoDefault = emoji === autoEmoji && !hasOverride;
        const className = cn(
          'relative flex size-9 items-center justify-center rounded-md text-lg transition-colors duration-150',
          isActive
            ? cn(
                isAutoDefault
                  ? 'bg-accent ring-muted-foreground/50 ring-1'
                  : 'bg-accent ring-foreground ring-1',
                // IdentityTab's auto-default state is dashed, matching its color
                // swatch convention; the celebratory panel's is solid.
                isAutoDefault && !celebratory && 'ring-dashed'
              )
            : 'hover:bg-accent/50 active:scale-90'
        );

        return (
          <EmojiButton
            key={emoji}
            celebratory={celebratory}
            onClick={() => onSelect(emoji)}
            className={className}
            ariaLabel={`Select icon ${emoji}`}
            justSelected={justSelectedKey === `emoji-${emoji}`}
          >
            {emoji}
          </EmojiButton>
        );
      })}
    </StaggerRoot>
  );
}

interface EmojiButtonProps {
  celebratory: boolean;
  onClick: () => void;
  className: string;
  ariaLabel: string;
  justSelected: boolean;
  children: ReactNode;
}

/**
 * One emoji cell. `celebratory` decides whether the button is a
 * `motion.button` carrying the entrance pop-in and hover/tap scale, or a
 * plain, static `button` — the same axis {@link ColorSwatch} gates on.
 */
function EmojiButton({
  celebratory,
  onClick,
  className,
  ariaLabel,
  justSelected,
  children,
}: EmojiButtonProps) {
  const burst = <AnimatePresence>{justSelected && <SelectionCheck />}</AnimatePresence>;

  if (!celebratory) {
    return (
      <button type="button" onClick={onClick} className={className} aria-label={ariaLabel}>
        {children}
        {burst}
      </button>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={onClick}
      className={className}
      aria-label={ariaLabel}
      variants={popIn}
      whileHover={{ scale: 1.25 }}
      whileTap={{ scale: 0.85 }}
      transition={{ type: 'spring', stiffness: 500, damping: 20 }}
    >
      {children}
      {burst}
    </motion.button>
  );
}
