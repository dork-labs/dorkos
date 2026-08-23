import * as React from 'react';
import { cn } from '@/layers/shared/lib';
import { Input } from './input';

interface BoundedNumberInputProps {
  /** The number the server currently holds. */
  value: number;
  /** Lowest number the schema accepts. */
  min: number;
  /** Highest number the schema accepts. */
  max: number;
  /** Called with a valid, in-range number when the reader finishes typing. */
  onCommit: (value: number) => void;
  /** Accessible name. Required — the row's visible label is not always a `<label>`. */
  'aria-label': string;
  /** Element ids describing this field, if the row draws its own description. */
  'aria-describedby'?: string;
  /** Whether the field is on hold. Keeps showing its value. */
  disabled?: boolean;
  /** Optional className for the input. */
  className?: string;
}

/**
 * A number field that only reports numbers its bounds accept.
 *
 * **Typing is not saving.** A field that wrote on every keystroke would send
 * `1`, `10` and `100` on the way to `1000` — three settings nobody chose, one of
 * which is in force for as long as the next keystroke takes. So the reader's
 * text is held locally and committed when they leave the field or press Enter,
 * and Escape puts back what the server holds.
 *
 * **Out of range does not silently become in range.** A number the bounds refuse
 * is not clamped and not written: clamping answers a different question than the
 * one that was asked, and a field showing `100` after somebody typed `500` is a
 * control lying about its own value. The field says what the range is instead
 * and waits.
 *
 * The value it shows follows the server while the reader is not typing, so an
 * optimistic write, a rollback, or a change made in another window all land
 * here — but never mid-edit, which would take the text out from under them.
 */
function BoundedNumberInput({
  value,
  min,
  max,
  onCommit,
  disabled,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: BoundedNumberInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const errorId = React.useId();

  const parsed = draft === null ? value : Number(draft);
  const invalid =
    draft !== null &&
    (draft.trim() === '' || !Number.isInteger(parsed) || parsed < min || parsed > max);

  const commit = () => {
    if (draft === null) return;
    if (invalid) return;
    setDraft(null);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={
          [ariaDescribedBy, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined
        }
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') setDraft(null);
        }}
        className={cn('w-24 tabular-nums', className)}
      />
      {invalid && (
        <p id={errorId} className="text-destructive text-xs">
          Enter a whole number from {min} to {max}.
        </p>
      )}
    </div>
  );
}

export { BoundedNumberInput };
export type { BoundedNumberInputProps };
