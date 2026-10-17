import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence } from 'motion/react';
import type { DocCommentMentionable } from '@dorkos/shared/doc-comments';
import type { AuthorRef } from '@/layers/entities/room';
import {
  MentionPalette,
  useMentionAutocomplete,
  type MentionRow,
} from '@/layers/features/mentions';
import { Button, Textarea } from '@/layers/shared/ui';

/** Props for {@link DocCommentComposer}. */
export interface DocCommentComposerProps {
  /** Everybody the comment can `@`-mention. */
  mentionable: readonly DocCommentMentionable[];
  /** The field's accessible name and placeholder. */
  placeholder: string;
  /** What the send button says. */
  submitLabel: string;
  /** The words to start with, when editing. */
  initialValue?: string;
  /**
   * Send the words. Resolves when they are saved, and the field clears then;
   * rejects when they were not, and the words stay. The caller says why.
   */
  onSubmit: (body: string) => Promise<unknown>;
  /** Close the composer, when it can be closed. */
  onCancel?: () => void;
  /**
   * Take the keyboard on mount. Every composer here opens because somebody
   * pressed Comment, Reply or Edit, so the press is the request to type.
   */
  focusOnMount?: boolean;
}

/** A roster entry in the shape the room mention picker reads. */
function asMember(person: DocCommentMentionable): { author: AuthorRef } {
  return {
    author: {
      id: person.id,
      kind: person.kind,
      displayName: person.displayName,
      handle: person.handle,
      ...(person.emoji ? { emoji: person.emoji } : {}),
      ...(person.color ? { color: person.color } : {}),
    },
  };
}

/**
 * The text box a comment or a reply is written in, with the same `@` picker
 * the room composer uses, so a handle written here is the handle the server
 * resolves. ⌘/Ctrl+Enter sends; Enter alone starts a new line.
 */
export function DocCommentComposer({
  mentionable,
  placeholder,
  submitLabel,
  initialValue = '',
  onSubmit,
  onCancel,
  focusOnMount,
}: DocCommentComposerProps) {
  const [text, setText] = useState(initialValue);
  const [sending, setSending] = useState(false);
  const [pendingCaret, setPendingCaret] = useState<{ pos: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const members = useMemo(() => mentionable.map(asMember), [mentionable]);
  const viewerAuthorId = mentionable.find((person) => person.isOwner)?.id ?? '';
  const mentions = useMentionAutocomplete({
    members,
    viewerAuthorId,
    text,
    sectionOrder: ['agents', 'people'],
  });

  // Mount only: the prop says how this composer came to be, which happens once.
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only; see above
  }, []);

  // The caret moves only once the inserted text is painted; see ChannelComposer.
  useLayoutEffect(() => {
    if (pendingCaret === null || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(pendingCaret.pos, pendingCaret.pos);
  }, [pendingCaret]);

  const take = (row: MentionRow) => {
    const inserted = mentions.selectRow(row);
    if (!inserted) return;
    setText(inserted.value);
    setPendingCaret({ pos: inserted.cursorPos });
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSubmit(body);
      setText('');
    } catch {
      // The caller said what went wrong; the words stay for another try.
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.isOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        mentions.dismiss();
        return;
      }
      if (mentions.hasSelectableRows) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (event.key === 'ArrowDown') mentions.moveDown();
          else mentions.moveUp();
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const inserted = mentions.selectHighlighted();
          if (inserted) {
            setText(inserted.value);
            setPendingCaret({ pos: inserted.cursorPos });
          }
          return;
        }
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="relative flex flex-col gap-2">
      <AnimatePresence>
        {mentions.isOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-1 w-full">
            <MentionPalette
              rows={mentions.rows}
              selectedIndex={mentions.selectedIndex}
              onSelect={take}
            />
          </div>
        )}
      </AnimatePresence>
      <Textarea
        ref={inputRef}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-controls={mentions.listboxId}
        aria-activedescendant={mentions.activeDescendantId}
        aria-autocomplete="list"
        rows={2}
        className="min-h-16 resize-none text-sm"
        onChange={(event) => {
          setText(event.target.value);
          mentions.noteTextChange(event.target.value);
          mentions.handleCursorChange(event.target.selectionStart);
        }}
        onSelect={(event) => mentions.handleCursorChange(event.currentTarget.selectionStart)}
        onBlur={() => mentions.dismiss()}
        onKeyDown={onKeyDown}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={!text.trim() || sending}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
