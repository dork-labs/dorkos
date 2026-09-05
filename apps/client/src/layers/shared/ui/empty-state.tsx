/**
 * The one shape a "nothing here" panel takes.
 *
 * Seven feature slices each built their own version of this — same icon,
 * headline, muted line and optional button, four different paddings and three
 * different icon wrappers (DOR-1763 finding 17.1). `MeshEmptyState` was already
 * the generic one; it just never moved somewhere the rest of the app could
 * reach it, so everybody rewrote it.
 *
 * @module shared/ui/empty-state
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib/utils';
import { Button, type ButtonProps } from './button';
import { Spinner } from './spinner';

const emptyStateIconVariants = cva('rounded-xl p-3', {
  variants: {
    tone: {
      /** Nothing is wrong — there is simply nothing here yet. */
      muted: 'bg-muted/50 text-muted-foreground',
      /** Something failed, and the panel is saying so. */
      destructive: 'bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: { tone: 'muted' },
});

/** The button an empty state offers, when it has something to offer. */
export interface EmptyStateAction {
  /** What the button says. Keep it a verb phrase — "Go to Discovery". */
  label: string;
  /** What pressing it does. */
  onClick: () => void;
  /** Fill treatment. Defaults to the primary button. */
  variant?: ButtonProps['variant'];
  /** Grey the button out — an action already in flight. */
  disabled?: boolean;
  /** Show a spinner in the button while the action runs. */
  busy?: boolean;
}

/** Everything an empty state renders. */
export interface EmptyStateProps extends VariantProps<typeof emptyStateIconVariants> {
  /** The glyph above the headline. */
  icon: LucideIcon;
  /** One short line saying what is missing. */
  headline: string;
  /** One more line saying what would fill it. */
  description: string;
  /** The way out, when there is one. */
  action?: EmptyStateAction;
  /** A faded sketch of what this panel looks like with content in it. */
  preview?: ReactNode;
  /**
   * Render the headline as a real heading at this level instead of a plain
   * paragraph — a navigable landmark for a panel that anchors a page or a
   * grid (e.g. the marketplace catalog, the topology canvas). Leave it off
   * — the default — for an empty state nested inside a section that already
   * has its own heading.
   */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/**
 * An empty panel that says what is missing and, when it can, what to do.
 *
 * Centred in whatever box it is given, so the caller owns the height and the
 * padding around it — a tab body, a card, a whole page.
 *
 * @param icon - The glyph above the headline.
 * @param headline - What is missing, in one short line.
 * @param description - What would fill it.
 * @param action - The way out, when there is one.
 * @param preview - A faded sketch of the filled state, rendered above the icon.
 * @param tone - `muted` (default) for an empty panel, `destructive` for a failed one.
 * @param headingLevel - Render the headline as an `h2`/`h3`/`h4` landmark instead of a paragraph.
 */
function EmptyState({
  icon: Icon,
  headline,
  description,
  action,
  preview,
  tone,
  headingLevel,
  className,
}: EmptyStateProps) {
  const Headline = headingLevel ? (`h${headingLevel}` as const) : 'p';
  return (
    <div
      data-slot="empty-state"
      className={cn('flex flex-col items-center justify-center gap-3 p-12 text-center', className)}
    >
      {preview && (
        <div className="pointer-events-none mb-4 w-full max-w-sm opacity-40 select-none">
          {preview}
        </div>
      )}
      <div className={emptyStateIconVariants({ tone })}>
        <Icon className="size-6" aria-hidden />
      </div>
      <div className="space-y-1">
        <Headline className="text-sm font-medium">{headline}</Headline>
        <p className="text-muted-foreground max-w-[280px] text-xs">{description}</p>
      </div>
      {action && (
        <Button
          size="sm"
          variant={action.variant}
          onClick={action.onClick}
          disabled={action.disabled || action.busy}
          className="mt-1"
        >
          {action.busy && <Spinner size="xs" />}
          {action.label}
        </Button>
      )}
    </div>
  );
}

export { EmptyState, emptyStateIconVariants };
