/**
 * One read-only fact: a label on the left, its value beside it.
 *
 * Four slices invented this independently — three called it `DetailRow`, one
 * called it `Row` — with four different ways of lining up the same two columns
 * and four different subsets of the features such a row needs (DOR-1763 finding
 * 17.3). `field.tsx` and `setting-row.tsx` cover label-plus-*control*; nothing
 * covered label-plus-*value*, so every panel that needed one wrote it again.
 *
 * The row owns structure, never type size or colour: the label is muted and the
 * value inherits, so a panel sets `text-xs` (or `text-2xs`) once on the block
 * and every row in it agrees.
 *
 * @module shared/ui/detail-row
 */
import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib/utils';
import { CopyButton } from './copy-button';

/** Everything a detail row draws. */
export interface DetailRowProps {
  /** What the fact is called. Also names the copy button, when there is one. */
  label: string;
  /** The fact itself. */
  children: ReactNode;
  /**
   * Where the value sits.
   *
   * `end` (default) pushes it to the right edge — a readout you scan down the
   * right-hand side. `start` puts it in a fixed second column, which is what
   * you want when the values are sentences rather than figures.
   */
  align?: 'start' | 'end';
  /** Let a long value break onto more lines instead of truncating. */
  wrap?: boolean;
  /** Nest under the row above it — a breakdown line. */
  indent?: boolean;
  /** A colour dot before the label, for rows that belong to a category. */
  swatch?: string;
  /** Show a copy button, and give it this text. */
  copyValue?: string;
  /** Extra classes for the label — a lighter tint, to read quieter than the value. */
  labelClassName?: string;
  /** Extra classes for the value — a mono face, a warning tint. */
  valueClassName?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * A label and its value on one line.
 *
 * @param label - What the fact is called.
 * @param children - The fact itself.
 * @param align - `end` (default) right-aligns the value; `start` gives it a fixed column.
 * @param wrap - Let the value break onto more lines instead of truncating.
 * @param indent - Nest the row under the one above it.
 * @param swatch - A colour dot before the label.
 * @param copyValue - Show a copy button carrying this text.
 * @param labelClassName - Extra classes for the label.
 * @param valueClassName - Extra classes for the value.
 */
function DetailRow({
  label,
  children,
  align = 'end',
  wrap = false,
  indent = false,
  swatch,
  copyValue,
  labelClassName,
  valueClassName,
  className,
  ...rest
}: DetailRowProps) {
  return (
    <div
      data-slot="detail-row"
      className={cn(
        'flex min-w-0 gap-2',
        wrap ? 'items-start' : 'items-baseline',
        indent && 'pl-4',
        className
      )}
      {...rest}
    >
      {swatch && (
        <span
          aria-hidden
          className="inline-block size-1.5 shrink-0 self-center rounded-full"
          style={{ backgroundColor: swatch }}
        />
      )}
      <span
        className={cn(
          'text-muted-foreground shrink-0',
          align === 'start' && 'w-20',
          labelClassName
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1',
          align === 'end' && 'text-right',
          // `break-words` rather than `break-all`: a path or an id still breaks
          // because it cannot fit on one line, but ordinary prose keeps its
          // words whole (charter, overflow containment).
          wrap ? 'break-words' : 'truncate',
          valueClassName
        )}
      >
        {children}
      </span>
      {copyValue !== undefined && <CopyButton value={copyValue} label={`Copy ${label}`} />}
    </div>
  );
}

export { DetailRow };
