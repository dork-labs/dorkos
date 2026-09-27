import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';
import { FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../../lib/presentation';

/**
 * How the card sits on its surface: a framed `card` of its own (the connect
 * dialog, the chat), or `embedded` as one section of a panel that already
 * shows the app, so the frame and the app's icon would only repeat it.
 */
export type AccessCardVariant = 'card' | 'embedded';

/** The access card's outer frame: the app's icon, the question, and an optional account line. */
export function AccessCardFrame({
  titleId,
  toolkit,
  title,
  subtitle,
  variant = 'card',
  className,
  children,
}: {
  titleId: string;
  toolkit: string | undefined;
  title: string;
  subtitle?: ReactNode;
  variant?: AccessCardVariant;
  className?: string;
  children: ReactNode;
}) {
  const Icon = (toolkit ? SERVICE_ICONS[toolkit] : undefined) ?? FALLBACK_SERVICE_ICON;
  const embedded = variant === 'embedded';
  return (
    <section
      aria-labelledby={titleId}
      data-testid="connection-access-card"
      className={cn(embedded ? 'space-y-3' : 'bg-card space-y-4 rounded-xl border p-4', className)}
    >
      <header className="flex items-start gap-3">
        {!embedded && (
          <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
            <Icon className="text-muted-foreground size-4" aria-hidden />
          </span>
        )}
        <div className="min-w-0">
          <h3 id={titleId} className="text-sm font-semibold">
            {title}
          </h3>
          {subtitle && <div className="text-muted-foreground mt-0.5 text-xs">{subtitle}</div>}
        </div>
      </header>
      {children}
    </section>
  );
}
