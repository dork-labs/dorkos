/**
 * One number a room may set for itself, and the default it falls back to.
 *
 * @module features/room-management/ui/RoomLimitRow
 */
import { useId, useState } from 'react';
import { Button, Input } from '@/layers/shared/ui';

export interface RoomLimitRowProps {
  /** What the number does, in the room's own words. */
  label: string;
  /** One short sentence under the label. */
  description: string;
  /** This room's own number, or `null` when it follows Settings. */
  value: number | null;
  /**
   * The number Settings holds right now, or `null` while it is still being
   * read. What "use the default" actually means today, so the field can say it.
   */
  fallback: number | null;
  /** Lowest number the schema accepts. */
  min: number;
  /** Highest number the schema accepts. */
  max: number;
  /** Whether the field is on hold: an unlimited room has nothing to bound. */
  disabled?: boolean;
  /** Set this room's number, or `null` to follow Settings again. */
  onCommit: (value: number | null) => void;
}

/**
 * A number field where empty is a real answer.
 *
 * Empty means "follow Settings", and it is shown as `Default (30)` rather than
 * as blankness, because the reader's actual question is not "is anything set
 * here" but "what happens in this room". A room that has never been touched
 * still says what bounds it.
 *
 * Committing on blur or Enter, and refusing rather than clamping an out-of-range
 * number, for the reasons `BoundedNumberInput` states next door. This is its own
 * component rather than that one with a flag because nullability changes what
 * every state means: empty is a value here, and an explicit `null` is what
 * clears an override server-side.
 */
export function RoomLimitRow({
  label,
  description,
  value,
  fallback,
  min,
  max,
  disabled,
  onCommit,
}: RoomLimitRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();

  const text = draft ?? (value === null ? '' : String(value));
  const trimmed = text.trim();
  const parsed = Number(trimmed);
  const invalid = trimmed !== '' && (!Number.isInteger(parsed) || parsed < min || parsed > max);

  const commit = () => {
    if (draft === null || invalid) return;
    setDraft(null);
    const next = trimmed === '' ? null : parsed;
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor={fieldId} className="text-sm font-medium">
            {label}
          </label>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        <Input
          id={fieldId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          // Never the shipped default when Settings has not been read: the
          // number in this placeholder is a claim about what happens in this
          // room, and guessing it makes the room describe somebody else's
          // install.
          placeholder={fallback === null ? 'Default' : `Default (${fallback})`}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') setDraft(null);
          }}
          className="w-28 shrink-0 text-right tabular-nums"
        />
      </div>
      {invalid && (
        <p id={errorId} className="text-destructive text-xs">
          Enter a whole number from {min} to {max}, or leave it empty for the default.
        </p>
      )}
      {/* Only when there is something to undo. Emptying the field does the same
          thing, and a reader who has not noticed that should not have to. */}
      {value !== null && draft === null && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground h-7 self-end px-2 text-xs"
          onClick={() => onCommit(null)}
        >
          Use the default
        </Button>
      )}
    </div>
  );
}
