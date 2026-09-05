/**
 * Renaming a session in place, once.
 *
 * All three session rows had grown the identical five-piece machine — open
 * state, draft value, a guard so the blur after a commit does not fire it
 * twice, a `requestAnimationFrame` focus that has to beat Radix's focus
 * restoration, and trim-and-no-op-if-unchanged — with the same variable names
 * and the same non-obvious comment pasted three times (DOR-1763 finding 17.7).
 *
 * @module entities/session/model/use-inline-rename
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useLatest } from '@/layers/shared/lib';

/** What the hook needs to know. */
export interface UseInlineRenameOptions {
  /**
   * The current name. Read when the editor opens, and again when it closes to
   * decide whether anything actually changed — so a rename that lands while the
   * editor is open is compared against the new name, not a stale one.
   */
  value: string;
  /** Called with the trimmed name, and only when it differs from `value`. */
  onCommit: (next: string) => void;
  /**
   * Runs once the editor has closed, whichever way it closed.
   *
   * The sidebar row uses it to put focus back on the row the input replaced:
   * without that, the input unmounts and focus falls to `<body>`, dropping a
   * keyboard reader out of the sidebar entirely.
   */
  onEnd?: () => void;
}

/** The editor's state and the four things you can do to it. */
export interface InlineRename {
  /** Whether the input is showing instead of the name. */
  isRenaming: boolean;
  /** What is typed so far. */
  renameValue: string;
  /** Type into it. */
  setRenameValue: (next: string) => void;
  /** Put this on the input — the hook focuses and selects it on open. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Open the editor with the current name selected. */
  start: () => void;
  /** Accept what is typed. Safe to call twice; the second call does nothing. */
  commit: () => void;
  /** Throw it away. */
  cancel: () => void;
  /** Wire to the input's `onKeyDown` — Enter commits, Escape cancels. */
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Rename something in place: one input, Enter to keep it, Escape to drop it.
 *
 * @param options - The current name, what to do with a new one, and an optional
 * hook for after the editor closes.
 */
export function useInlineRename({ value, onCommit, onEnd }: UseInlineRenameOptions): InlineRename {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // First Enter, Escape or blur decides; the blur that FOLLOWS a commit is a
  // no-op. Without this the commit fires twice and the second one compares the
  // draft against a name that has already changed.
  const committedRef = useRef(false);

  const latestValue = useLatest(value);
  const latestCommit = useLatest(onCommit);
  const latestEnd = useLatest(onEnd);

  useEffect(() => {
    if (!isRenaming) return;
    committedRef.current = false;
    // After the menu that opened it has finished closing: Radix restores focus
    // one commit later, and it would take it straight back off this field.
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [isRenaming]);

  const end = useCallback(() => {
    setIsRenaming(false);
    latestEnd.read()?.();
  }, [latestEnd]);

  const start = useCallback(() => {
    setRenameValue(latestValue.read());
    setIsRenaming(true);
  }, [latestValue]);

  const commit = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    end();
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === latestValue.read()) return;
    latestCommit.read()(trimmed);
  }, [end, renameValue, latestValue, latestCommit]);

  const cancel = useCallback(() => {
    committedRef.current = true;
    end();
  }, [end]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    },
    [commit, cancel]
  );

  return {
    isRenaming,
    renameValue,
    setRenameValue,
    inputRef,
    start,
    commit,
    cancel,
    handleKeyDown,
  };
}
