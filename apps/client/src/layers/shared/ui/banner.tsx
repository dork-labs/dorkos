import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AnimatePresence, motion } from 'motion/react';
import { Info, OctagonX, Sparkles, TriangleAlert, X, type LucideIcon } from 'lucide-react';

import { cn } from '@/layers/shared/lib/utils';

/**
 * Severity ladder for the app banner system. `success` is intentionally absent —
 * a success is a transient event best expressed as a toast, whereas a banner
 * marks a standing condition that persists until resolved.
 */
export type BannerVariant = 'critical' | 'warning' | 'info' | 'neutral';

const bannerVariants = cva('border-b px-4 py-1.5 text-xs', {
  variants: {
    variant: {
      critical: 'bg-status-error-bg border-status-error-border text-status-error-fg',
      warning: 'bg-status-warning-bg border-status-warning-border text-status-warning-fg',
      info: 'bg-status-info-bg border-status-info-border text-status-info-fg',
      neutral: 'bg-muted/40 border-border text-foreground',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

/** Default leading icon per variant — mirrors the toast icon choices in `sonner.tsx`. */
const VARIANT_ICON: Record<BannerVariant, LucideIcon> = {
  critical: OctagonX,
  warning: TriangleAlert,
  info: Info,
  neutral: Sparkles,
};

export interface BannerProps
  extends Omit<React.ComponentProps<'div'>, 'role'>, VariantProps<typeof bannerVariants> {
  /** Leading icon override. Pass `null` to hide it; omit for the per-variant default. */
  icon?: LucideIcon | null;
  /** Right-aligned action controls (buttons). Wraps below the message on narrow widths. */
  actions?: React.ReactNode;
  /** Dismiss handler. When provided, a dismiss button appears; omit for non-dismissible banners. */
  onDismiss?: () => void;
  /** Accessible label for the dismiss button. */
  dismissLabel?: string;
  /** Collapsible detail content, revealed with a height animation while `detailsOpen` is true. */
  details?: React.ReactNode;
  /** Whether the {@link BannerProps.details} region is expanded. */
  detailsOpen?: boolean;
}

/**
 * A full-width app banner for a standing condition — one horizontal row with a
 * leading icon, a message, optional inline actions, an optional dismiss button,
 * and an optional collapsible details region for progressive disclosure.
 *
 * `critical` announces via `role="alert"` (assertive); every other variant uses
 * `role="status"` (polite) so a persistent banner never steals focus. The layout
 * wraps at narrow widths — the message takes the full row and actions drop to a
 * second line — and the details region scrolls horizontally rather than pushing
 * the page wider.
 *
 * @param variant - Severity, driving color and the announce role. Defaults to `neutral`.
 * @param icon - Leading icon override; `null` hides it, omitted uses the per-variant default.
 * @param actions - Right-aligned action controls.
 * @param onDismiss - When set, renders a dismiss button that calls this.
 * @param dismissLabel - Accessible label for the dismiss button.
 * @param details - Collapsible detail content.
 * @param detailsOpen - Whether the details region is expanded.
 */
export function Banner({
  variant = 'neutral',
  icon,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss',
  details,
  detailsOpen = false,
  className,
  children,
  ...props
}: BannerProps) {
  const Icon = icon === null ? null : (icon ?? VARIANT_ICON[variant ?? 'neutral']);
  const role = variant === 'critical' ? 'alert' : 'status';

  return (
    <div
      data-slot="banner"
      data-variant={variant}
      role={role}
      className={cn(bannerVariants({ variant }), 'flex flex-col', className)}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
        <div className="min-w-0 flex-1 basis-64 leading-snug">{children}</div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            className="focus-visible:ring-ring/50 -m-1 shrink-0 rounded-sm p-1 opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {detailsOpen && details && (
          <motion.div
            key="details"
            // Silence the surrounding role="status" live region for the details
            // content — expanding it should not read the raw payload aloud.
            aria-live="off"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="overflow-x-auto pt-2">{details}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export { bannerVariants };
