import type { Ref } from 'react';
import { cn } from '@/layers/shared/lib';

/** Props for {@link GalleryCard}. */
export interface GalleryCardProps {
  /** The face — an emoji string or an icon node. */
  face: React.ReactNode;
  /** The card's headline (a job title or "Design your own"). */
  title: string;
  /** One outcome line under the title. */
  subtitle: string;
  /** Optional connection/cadence chips. */
  chips?: string[];
  /** `design` gets the dashed, lead-card treatment; `template` is a job listing. */
  variant: 'design' | 'template';
  /** Roving-tabindex value set by the gallery (0 for the focused card, else -1). */
  tabIndex: number;
  /** Select this card. */
  onSelect: () => void;
  /** Arrow-key handler from the gallery (roving focus across cards). */
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  /** Forwarded to the button so the gallery can move focus across cards. */
  ref?: Ref<HTMLButtonElement>;
  'data-testid'?: string;
}

/**
 * One gallery card (M2). The `design` variant is the outcome-named lead card
 * ("Design your own"); `template` cards read like job listings — a face, a
 * human name, what the agent does, and connection chips. Selection is a single
 * click or Enter/Space; the gallery owns arrow-key movement across cards.
 *
 * @param props - Face, copy, chips, variant, and selection wiring.
 */
export function GalleryCard({
  face,
  title,
  subtitle,
  chips,
  variant,
  tabIndex,
  onSelect,
  onKeyDown,
  ref,
  'data-testid': testId,
}: GalleryCardProps) {
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      data-gallery-card=""
      data-testid={testId}
      className={cn(
        'card-interactive group flex h-full flex-col gap-2 rounded-xl border p-4 text-left',
        'transition-all duration-200',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        variant === 'design'
          ? 'border-primary/40 bg-primary/5 hover:border-primary/60 border-dashed'
          : 'bg-card hover:border-border/80 hover:shadow-md'
      )}
    >
      <span className="text-3xl leading-none" aria-hidden>
        {face}
      </span>
      <div className="space-y-0.5">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{subtitle}</p>
      </div>
      {chips && chips.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          {chips.map((chip) => (
            <span
              key={chip}
              className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px]"
            >
              {chip}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
