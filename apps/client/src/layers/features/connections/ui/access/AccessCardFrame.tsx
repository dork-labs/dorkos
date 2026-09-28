import type { ReactNode } from 'react';
import { ServiceMark, type ServiceLogo } from '@/layers/entities/connectors';
import { cn } from '@/layers/shared/lib';

/**
 * How the card sits on its surface: a framed `card` of its own (the connect
 * dialog, the chat), or `embedded` as one section of a panel that already
 * shows the app, so the frame and the app's icon would only repeat it.
 */
export type AccessCardVariant = 'card' | 'embedded';

/** The access card's outer frame: the app's mark, the question, and an optional account line. */
export function AccessCardFrame({
  titleId,
  toolkit,
  serviceName,
  logo,
  title,
  subtitle,
  variant = 'card',
  className,
  children,
}: {
  titleId: string;
  toolkit: string | undefined;
  /** The app's name; its first letter is the mark when the app has no logo. */
  serviceName: string;
  /** What the catalog says about the app's logo, when the caller has its entry. */
  logo?: ServiceLogo;
  title: string;
  subtitle?: ReactNode;
  variant?: AccessCardVariant;
  className?: string;
  children: ReactNode;
}) {
  const embedded = variant === 'embedded';
  return (
    <section
      aria-labelledby={titleId}
      data-testid="connection-access-card"
      className={cn(embedded ? 'space-y-3' : 'bg-card space-y-4 rounded-xl border p-4', className)}
    >
      <header className="flex items-start gap-3">
        {!embedded && (
          <ServiceMark
            iconKey={toolkit ?? ''}
            displayName={serviceName}
            logo={logo}
            className="size-9 rounded-lg"
          />
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
