import { cn } from '@/layers/shared/lib';
import { useIsDark, useNebulaAlpha } from '../lib/nebula-theme';

/** Minimal color palette required by PresetPill. */
export interface PresetPillColors {
  nebula: string;
  wisp: string;
  stroke: string;
  strokeEnd: string;
}

export interface PresetPillProps extends React.ComponentProps<'button'> {
  /** Emoji icon shown before the name. */
  emoji: string;
  /** Display name for the preset. */
  name: string;
  /** Color palette for gradients and borders. */
  colors: PresetPillColors;
  /** Whether this pill is the active/selected preset. @default false */
  active?: boolean;
  /** Size variant. @default 'default' */
  size?: 'sm' | 'default';
  /** Show glow shadow when active. @default false */
  glow?: boolean;
  /** Use gradient text instead of solid foreground text. @default false */
  gradientText?: boolean;
}

/** Nebula-themed pill for displaying a personality preset. */
export function PresetPill({
  emoji,
  name,
  colors,
  active = false,
  size = 'default',
  glow = false,
  gradientText = false,
  className,
  style,
  ...props
}: PresetPillProps) {
  const isDark = useIsDark();
  const na = useNebulaAlpha();

  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium transition-all',
        size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1 text-xs',
        active
          ? 'text-foreground'
          : 'bg-accent text-muted-foreground hover:text-foreground border-transparent',
        className
      )}
      style={{
        ...(active
          ? {
              borderColor: colors.stroke + na.pillBorder,
              background: `linear-gradient(135deg, ${colors.nebula}${na.pillBgStart}, ${colors.wisp}${na.pillBgEnd})`,
              ...(glow ? { boxShadow: `0 0 12px ${colors.nebula}${na.pillGlow}` } : {}),
              ...(!isDark ? { borderColor: colors.stroke + 'AA' } : {}),
            }
          : {}),
        ...style,
      }}
      {...props}
    >
      <span>{emoji}</span>
      {gradientText ? (
        <span
          className="bg-clip-text text-transparent"
          style={{
            backgroundImage: `linear-gradient(135deg, ${colors.stroke}, ${colors.strokeEnd})`,
            ...(!isDark ? { filter: 'brightness(0.65) saturate(1.3)' } : {}),
          }}
        >
          {name}
        </span>
      ) : (
        <span>{name}</span>
      )}
    </button>
  );
}
