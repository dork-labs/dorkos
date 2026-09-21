import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib';
import { useIsDark, useNebulaAlpha } from '../lib/nebula-theme';

/** Minimal color palette required by PresetPill. */
export interface PresetPillColors {
  nebula: string;
  wisp: string;
  stroke: string;
  strokeEnd: string;
}

/**
 * The pill's two class axes: how big it is, and which of its three states it is in.
 *
 * `state` is one axis rather than the two independent booleans (`active`, `glow`)
 * this component used to take. The glow only ever drew on an active pill, so
 * `glow` without `active` was a combination the types allowed and the render
 * ignored — `glowing` is now simply the third rung of one ladder, and the
 * unreachable state no longer exists. `active` and `glowing` paint the same
 * classes on purpose: the glow itself is a `box-shadow` computed from the
 * preset's own colors, so it lives in inline `style` beside the gradient.
 *
 * **Deliberately not exported.** The shadcn convention that pairs a component
 * with its `componentVariants` is scoped to the primitives in `shared/ui`
 * (`.claude/rules/components.md`); this is an entity component whose variants
 * are read only by the props type below.
 */
const presetPillVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium transition-[color,background-color,border-color,box-shadow]',
  {
    variants: {
      size: {
        /** Inside the stacked, narrow picker. */
        sm: 'text-2xs px-2.5 py-1',
        /** The default step, matching the `xs · sm · md · lg` scale. */
        md: 'px-3 py-1 text-xs',
      },
      state: {
        /** Not the selected preset: a plain accent chip. */
        rest: 'bg-accent text-muted-foreground hover:text-foreground border-transparent',
        /** The selected preset. Its gradient and border come from inline `style`. */
        active: 'text-foreground',
        /** Selected, and casting the preset's own colored glow. */
        glowing: 'text-foreground',
      },
    },
    defaultVariants: { size: 'md', state: 'rest' },
  }
);

/**
 * The name's own axis, independent of {@link presetPillVariants}'s `state`.
 *
 * Gradient text is not state-gated — a resting pill may render it — so folding
 * it into `state` would have made the three-rung ladder a six-cell matrix for
 * no reason.
 */
const presetPillLabelVariants = cva('', {
  variants: {
    gradient: {
      true: 'bg-clip-text text-transparent',
      false: '',
    },
  },
  defaultVariants: { gradient: false },
});

export interface PresetPillProps
  extends React.ComponentProps<'button'>, VariantProps<typeof presetPillVariants> {
  /** Emoji icon shown before the name. */
  emoji: string;
  /** Display name for the preset. */
  name: string;
  /** Color palette for gradients and borders. */
  colors: PresetPillColors;
  /** Use gradient text instead of solid foreground text. @default false */
  gradientText?: boolean;
}

/** Nebula-themed pill for displaying a personality preset. */
export function PresetPill({
  emoji,
  name,
  colors,
  size = 'md',
  state = 'rest',
  gradientText = false,
  className,
  style,
  ...props
}: PresetPillProps) {
  const isDark = useIsDark();
  const na = useNebulaAlpha();
  const selected = state === 'active' || state === 'glowing';

  return (
    <button
      type="button"
      className={cn(presetPillVariants({ size, state }), className)}
      style={{
        ...(selected
          ? {
              borderColor: isDark ? colors.stroke + na.pillBorder : colors.stroke + 'AA',
              background: `linear-gradient(135deg, ${colors.nebula}${na.pillBgStart}, ${colors.wisp}${na.pillBgEnd})`,
              ...(state === 'glowing'
                ? { boxShadow: `0 0 12px ${colors.nebula}${na.pillGlow}` }
                : {}),
            }
          : {}),
        ...style,
      }}
      {...props}
    >
      <span>{emoji}</span>
      <span
        className={presetPillLabelVariants({ gradient: gradientText })}
        style={
          gradientText
            ? {
                backgroundImage: `linear-gradient(135deg, ${colors.stroke}, ${colors.strokeEnd})`,
                ...(!isDark ? { filter: 'brightness(0.65) saturate(1.3)' } : {}),
              }
            : undefined
        }
      >
        {name}
      </span>
    </button>
  );
}
