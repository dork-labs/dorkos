import type { ReactNode } from 'react';
import { ArrowUpRight, Lock } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { ExternalLinkAnchor } from '@/layers/shared/ui';

/**
 * One section of the Settings tab: a heading, an optional count beside it, an optional action on
 * the right, an optional reason under it, and a tinted group of rows. The group is a tint with no
 * border and no dividers, as the house rule on hairlines asks.
 */
export function SettingsSection({
  title,
  meta,
  action,
  reason,
  children,
  testId,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  /** Why the section is read-only: a sentence gets a lock; a node (a link) is shown as it is. */
  reason?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const headingId = `space-settings-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex min-h-8 items-center gap-2 px-1">
        <h2 id={headingId} className="text-sm font-semibold">
          {title}
        </h2>
        {meta && <span className="text-muted-foreground text-xs">{meta}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {typeof reason === 'string' ? (
        <LockedReason className="px-1">{reason}</LockedReason>
      ) : (
        reason && <div className="px-1">{reason}</div>
      )}
      <div className="bg-muted flex flex-col rounded-xl py-1">{children}</div>
    </section>
  );
}

/**
 * One row: a label with an optional reason under it, and the value or control on the right.
 * `stacked` puts the value under the label, for a long one such as a description.
 */
export function SettingsRow({
  label,
  description,
  reason,
  children,
  stacked = false,
}: {
  label: ReactNode;
  description?: string;
  reason?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex gap-x-4 gap-y-1.5 px-4 py-3',
        stacked ? 'flex-col' : 'flex-wrap items-center justify-between'
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-sm font-medium">{label}</div>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
        {typeof reason === 'string' ? <LockedReason>{reason}</LockedReason> : reason}
      </div>
      {children !== undefined && (
        <div className={cn('min-w-0 text-sm', !stacked && 'text-right')}>{children}</div>
      )}
    </div>
  );
}

/** Why something here is read-only: a lock and one line. Never a disabled input. */
export function LockedReason({ children, className }: { children: string; className?: string }) {
  return (
    <p className={cn('text-muted-foreground flex items-center gap-1.5 text-xs', className)}>
      <Lock aria-hidden className="size-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A square tile with a letter, for a space or an agent that has no picture here. */
export function LetterTile({
  letter,
  color,
  size = 'sm',
}: {
  letter: string;
  color: string;
  size?: 'sm' | 'lg';
}) {
  return (
    <span
      aria-hidden
      style={{ backgroundColor: color }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold text-white',
        size === 'lg' ? 'size-12 rounded-xl text-xl' : 'size-7 rounded-lg text-xs'
      )}
    >
      {letter}
    </span>
  );
}

/**
 * Where an owner or admin changes what this tab only shows: the space's own web settings, which
 * check their sign-in there. No lock: it is a way through, not a wall.
 */
export function ManageOnWeb({ href }: { href: string }) {
  return (
    <ExternalLinkAnchor
      href={href}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
    >
      Manage this in web settings
      <ArrowUpRight aria-hidden className="size-3" />
    </ExternalLinkAnchor>
  );
}
