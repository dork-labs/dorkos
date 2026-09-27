import type { ComponentPropsWithRef, ReactNode } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button, Spinner } from '@/layers/shared/ui';

/** One titled section of an app's side panel ("Who answers", "Recently", "Try it"). */
export function PanelSection({
  title,
  description,
  action,
  children,
  testId,
}: {
  /** The section's name. */
  title: string;
  /** One quiet line under the name. */
  description?: string;
  /** A small action on the heading's right ("See all", "+ Add"). */
  action?: ReactNode;
  /** The section's content. */
  children: ReactNode;
  /** Test hook for the section. */
  testId?: string;
}) {
  const id = `panel-section-${title.toLowerCase().replaceAll(/\s+/gu, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-2.5" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold">
            {title}
          </h3>
          {description && <p className="text-muted-foreground text-xs">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The one fix a broken or paused app needs, on top of its panel: what is
 * wrong in one sentence, and one button. Nothing else in the panel moves.
 */
export function PanelFix({
  message,
  detail,
  action,
  onAction,
  pending = false,
  secondary,
}: {
  /** What is wrong, plainly ("Signed out. Agents can't use Notion."). */
  message: string;
  /** One quieter line under the message: why, and what happens next. */
  detail?: string;
  /** The fix's button label. */
  action: string;
  /** Run the fix. */
  onAction: () => void;
  /** True while the fix is running. */
  pending?: boolean;
  /** A second, quieter choice beside the fix. */
  secondary?: ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid="app-panel-fix"
      className="bg-status-warning-bg flex flex-col gap-3 rounded-xl p-3.5"
    >
      <p className="text-status-warning-fg flex items-start gap-2 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {message}
          {detail && <span className="mt-1 block">{detail}</span>}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={onAction}
          disabled={pending}
          className="h-auto min-h-8 max-w-full whitespace-normal"
        >
          {pending && <Spinner size="xs" />}
          {action}
        </Button>
        {secondary}
      </div>
    </div>
  );
}

/** Props for {@link PanelMoreRow}. */
export interface PanelMoreRowProps extends ComponentPropsWithRef<'button'> {
  /** What the row does or opens. */
  label: string;
  /** One quiet line under the label. */
  hint?: string;
  /** Draws the row in the destructive colour (Disconnect…, Remove…). */
  destructive?: boolean;
}

/**
 * One line under "More": a label, an optional hint, and a chevron. Takes a
 * ref so it can be a collapsible's trigger.
 */
export function PanelMoreRow({
  label,
  hint,
  destructive = false,
  className,
  ref,
  ...props
}: PanelMoreRowProps) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'group/more-row hover:bg-muted/50 focus-ring flex min-h-10 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors disabled:opacity-50',
        className
      )}
      {...props}
    >
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', destructive && 'text-destructive')}>{label}</span>
        {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
      </span>
      <ChevronRight
        className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]/more-row:rotate-90"
        aria-hidden
      />
    </button>
  );
}
