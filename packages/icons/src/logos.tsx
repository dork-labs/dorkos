/**
 * Inline DorkOS logo component — replaces static SVG files with a single
 * React component supporting color variants.
 *
 * @module icons/logos
 */
import { LOGO_COLORS, type LogoVariant } from './brand';

interface DorkLogoProps {
  /** Color variant — 'default' (charcoal), 'white', or 'orange' (red). */
  variant?: LogoVariant;
  /** Width in pixels. Height scales proportionally (viewBox is 2325x799). */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/** Inline SVG logo for DorkOS. Renders identically to the static dork-logo*.svg files. */
export function DorkLogo({ variant = 'default', size = 40, className, style }: DorkLogoProps) {
  const color = LOGO_COLORS[variant];
  const height = size * (799 / 2325);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={height}
      viewBox="0 0 2325 799"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <rect x="50" y="50" width="2225" height="699" stroke={color} strokeWidth="100" />
      <path
        d="M492.333 199.627L599.833 295.627L600 295.776V491.707L492.207 599.5H199.5V199.5H492.19L492.333 199.627ZM334 347.5V448.5H435V347.5H334Z"
        fill={color}
      />
      <path
        d="M1108.5 497.715L1108.34 497.862L1001.34 599.362L1001.2 599.5H699V296.283L699.158 296.135L802.158 199.635L802.303 199.5H1108.5V497.715ZM855 347.5V448.5H956V347.5H855Z"
        fill={color}
      />
      <path
        d="M1616.94 200.24L1510.07 395.005L1616.94 598.768L1617.64 600.103L1616.28 599.451L1409 500.056L1208.22 599.448L1207.5 599.806V199.5H1617.34L1616.94 200.24ZM1332 337.5V439.207L1433.71 337.5H1332Z"
        fill={color}
      />
      <path
        d="M1716.5 599V200L1841 291.5L2125 200L2017.5 400L2125 599L1841 501L1716.5 599Z"
        fill={color}
        stroke={color}
      />
    </svg>
  );
}
