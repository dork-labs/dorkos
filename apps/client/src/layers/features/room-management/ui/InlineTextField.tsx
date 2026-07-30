/**
 * A line of text you edit by pressing it.
 *
 * @module features/room-management/ui/InlineTextField
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

export interface InlineTextFieldProps {
  /** What is stored today, or `''` when there is nothing yet. */
  value: string;
  /**
   * Write the trimmed text.
   *
   * Called at most once per edit, and never with text that changes nothing —
   * see {@link InlineTextField} for the guard that makes both true.
   */
  onCommit: (next: string) => void;
  /** Longest the server accepts, so typing stops there instead of failing later. */
  maxLength: number;
  /** What this line is, in a word or two: `Room name`, `Topic`. */
  label: string;
  /** What the line says when nothing is stored yet. Never blank space. */
  placeholder: string;
  /**
   * Whether emptying the field means something.
   *
   * A topic can be removed, so `''` is a real edit there. A room with no name
   * is not a room, so an empty name is simply a cancel.
   */
  commitEmpty?: boolean;
  /** Applied to the line AND the editor, so the text does not resize mid-edit. */
  className?: string;
}

/**
 * Press the text, type, Enter commits, Escape cancels.
 *
 * **The commit guard is the whole difficulty.** Enter commits and blurs, and the
 * blur handler commits too — so a single Enter used to write twice, and a
 * double-Enter three times. `committedRef` makes the first Enter or Escape the
 * only one that decides; everything after it is a no-op. That pattern is
 * `RoomRow`'s, where it fixed a real double-write, and it is copied here rather
 * than reinvented.
 *
 * **Focus is handed back to the line the editor replaced.** Without it the
 * editor unmounts under the cursor and focus falls to `<body>`, dropping a
 * keyboard reader out of the sheet entirely — they would have to Tab in from
 * the top of the page to reach the field they just edited.
 *
 * **Touch gets a visible affordance.** Pressing bare text to edit it is a
 * pointer idiom that a finger has no way to discover, so the pencil is always
 * drawn below 768px and the line is a full 44px tall there. Above it the pencil
 * appears on hover or keyboard focus, where the cursor already says the line is
 * live.
 */
export function InlineTextField({
  value,
  onCommit,
  maxLength,
  label,
  placeholder,
  commitEmpty = false,
  className,
}: InlineTextFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const lineRef = useRef<HTMLButtonElement>(null);
  /** Whether this edit has already been decided. First Enter or Escape wins. */
  const committedRef = useRef(false);

  useEffect(() => {
    if (!isEditing) return;
    committedRef.current = false;
    // After the commit that swaps the line for the field.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [isEditing]);

  const startEditing = () => {
    // Seeded here rather than kept in step with `value`: the draft belongs to
    // one edit, and a room renamed in another tab mid-edit must not rewrite
    // what somebody is typing.
    setDraft(value);
    setIsEditing(true);
  };

  const endEditing = () => {
    setIsEditing(false);
    requestAnimationFrame(() => lineRef.current?.focus());
  };

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    endEditing();
    const trimmed = draft.trim();
    if (trimmed === value) return;
    if (trimmed === '' && !commitEmpty) return;
    // No per-call `onError`: the shared mutation toast names the action from the
    // hook's `meta` and appends the server's own sentence.
    onCommit(trimmed);
  };

  const cancel = () => {
    committedRef.current = true;
    endEditing();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={maxLength}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        className={cn(
          'bg-background text-foreground focus-visible:ring-ring w-full min-w-0 rounded border px-1.5 py-0.5 outline-hidden focus-visible:ring-1',
          className
        )}
      />
    );
  }

  const isEmpty = value === '';
  return (
    <button
      ref={lineRef}
      type="button"
      onClick={startEditing}
      className={cn(
        'group/inline focus-visible:ring-ring flex min-h-11 w-full items-center gap-1.5 rounded text-left outline-hidden focus-visible:ring-2 md:min-h-0',
        className
      )}
    >
      {/* The action, so the control is not named by data alone — and the value
          stays in the name, which is what voice control needs to reach it. */}
      <span className="sr-only">{label}:</span>
      <span className={cn('truncate', isEmpty && 'text-muted-foreground font-normal')}>
        {isEmpty ? placeholder : value}
      </span>
      <Pencil
        aria-hidden
        className="size-3.5 shrink-0 transition-opacity md:opacity-0 md:group-hover/inline:opacity-100 md:group-focus-visible/inline:opacity-100"
      />
    </button>
  );
}
