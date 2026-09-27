import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';
import { STATUS_TONE_DOT, type StatusTone } from '@/layers/shared/ui';

/** A way's state: a coloured dot and the word beside it. */
export interface WayStatus {
  /** Colour of the dot. */
  tone: StatusTone;
  /** The state in one or two words. */
  label: string;
}

/**
 * One row in "How DorkOS reaches your apps": the way's name, a quiet detail
 * line, its state, and its actions. Anything the row needs to say at more
 * length (a refusal, an inline key form) goes in `children`, under the row.
 *
 * On a phone the actions wrap under the name rather than squeezing it.
 */
export function WayRow({
  testId,
  name,
  detail,
  status,
  actions,
  children,
}: {
  /** Test hook for the row. */
  testId: string;
  /** "Your DorkOS account", "Your Composio key". */
  name: string;
  /** "4 apps connected · using your project key". */
  detail: string;
  /** The way's state. */
  status: WayStatus;
  /** Buttons for this way. */
  actions?: ReactNode;
  /** Extra lines under the row. */
  children?: ReactNode;
}) {
  return (
    <li data-testid={testId} className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-muted-foreground text-xs">{detail}</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs">
          <span className={cn('size-2 rounded-full', STATUS_TONE_DOT[status.tone])} aria-hidden />
          {status.label}
        </span>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </li>
  );
}
