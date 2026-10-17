import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type {
  DocCommentAnchor,
  DocCommentThread,
  DocCommentUnreached,
  DocRef,
} from '@dorkos/shared/doc-comments';
import {
  useCreateDocCommentThread,
  useDocCommentMentionable,
  useEditDocComment,
  useReplyDocComment,
  useSetDocCommentThreadResolved,
} from '@/layers/entities/doc';
import { Button, Label, Switch } from '@/layers/shared/ui';
import { unreachedNote, type ThreadPlacement } from '../lib/comment-copy';
import { DocCommentComposer } from './DocCommentComposer';
import { DocCommentThreadCard } from './DocCommentThreadCard';

/** What the panel says when a write did not reach the server. */
const SAVE_FAILED = 'Couldn’t save the comment. Try again.';

/** What the panel says after a write: who it could not wake, or nothing. */
function noticeOf(unreached: readonly DocCommentUnreached[]): string | null {
  return unreached.length > 0 ? unreached.map(unreachedNote).join(' ') : null;
}

/** Props for {@link DocCommentsPanel}. */
export interface DocCommentsPanelProps {
  /** The doc. */
  doc: DocRef;
  /** Every thread on it, resolved ones included. */
  threads: readonly DocCommentThread[];
  /** The thread emphasized in the doc, or `null`. */
  activeId: string | null;
  /** Emphasize a thread. */
  onActiveChange: (id: string | null) => void;
  /** Whether resolved threads show. */
  showResolved: boolean;
  /** Show or hide resolved threads. */
  onShowResolvedChange: (show: boolean) => void;
  /** How the editor placed a thread in the text now. */
  placementOf: (id: string) => ThreadPlacement;
  /** An anchor for the editor's selection, or `null` when nothing is selected. */
  anchorSelection: () => DocCommentAnchor | null;
  /** Select a thread's words in the editor and scroll to them. */
  reveal: (id: string) => void;
}

/**
 * The comments panel beside a doc: open a thread on the selection, read and
 * answer threads, resolve and reopen them, and hear about a mention that woke
 * nobody.
 */
export function DocCommentsPanel({
  doc,
  threads,
  activeId,
  onActiveChange,
  showResolved,
  onShowResolvedChange,
  placementOf,
  anchorSelection,
  reveal,
}: DocCommentsPanelProps) {
  const mentionable = useDocCommentMentionable().data ?? [];
  const create = useCreateDocCommentThread(doc);
  const reply = useReplyDocComment(doc);
  const setResolved = useSetDocCommentThreadResolved(doc);
  const edit = useEditDocComment(doc);
  const [pending, setPending] = useState<DocCommentAnchor | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visible = threads.filter((thread) => showResolved || !thread.resolved);
  const resolvedCount = threads.filter((thread) => thread.resolved).length;

  const startComment = () => {
    const anchor = anchorSelection();
    if (!anchor) {
      setNotice('Select some text in the doc first.');
      return;
    }
    setNotice(null);
    setPending(anchor);
  };

  /** Run a write; on failure say so and rethrow, so the composer keeps the words. */
  const saving = async <T,>(write: () => Promise<T>): Promise<T> => {
    try {
      return await write();
    } catch (err) {
      setNotice(SAVE_FAILED);
      throw err;
    }
  };

  return (
    <aside aria-label="Comments" className="flex w-full shrink-0 flex-col gap-3 @3xl:w-72">
      <div className="flex items-center gap-2">
        <h2 className="text-foreground text-sm font-medium">Comments</h2>
        {threads.length > 0 && (
          <span className="text-muted-foreground text-xs">{threads.length}</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto"
          // Keeps the editor's selection: a press that took focus first would
          // leave nothing selected to comment on.
          onMouseDown={(event) => event.preventDefault()}
          onClick={startComment}
          aria-label="Comment on the selected text"
        >
          <MessageSquarePlus /> Comment
        </Button>
      </div>
      {resolvedCount > 0 && (
        <div className="flex items-center gap-2">
          <Switch
            id="doc-comments-show-resolved"
            checked={showResolved}
            onCheckedChange={onShowResolvedChange}
          />
          <Label htmlFor="doc-comments-show-resolved" className="text-muted-foreground text-xs">
            Show resolved ({resolvedCount})
          </Label>
        </div>
      )}
      <p role="status" className="text-muted-foreground text-xs empty:hidden">
        {notice}
      </p>
      {pending && (
        <DocCommentComposer
          mentionable={mentionable}
          placeholder="Add a comment. Type @ to mention an agent."
          submitLabel="Comment"
          focusOnMount
          onSubmit={async (body) => {
            const result = await saving(() => create.mutateAsync({ anchor: pending, body }));
            setPending(null);
            onActiveChange(result.thread.id);
            setNotice(noticeOf(result.unreached));
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {threads.length === 0 && !pending ? (
        <div className="text-muted-foreground text-xs">
          <p className="text-foreground font-medium">No comments yet</p>
          <p>Select text, then press Comment.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((thread) => (
            <DocCommentThreadCard
              key={thread.id}
              thread={thread}
              placement={placementOf(thread.id)}
              active={thread.id === activeId}
              mentionable={mentionable}
              onActivate={() => {
                onActiveChange(thread.id);
                reveal(thread.id);
              }}
              onReply={async (body) => {
                const result = await saving(() => reply.mutateAsync({ threadId: thread.id, body }));
                setNotice(noticeOf(result.unreached));
              }}
              onSetResolved={(resolved) => setResolved.mutate({ threadId: thread.id, resolved })}
              onEdit={(commentId, body) =>
                saving(() => edit.mutateAsync({ threadId: thread.id, commentId, body }))
              }
            />
          ))}
        </div>
      )}
    </aside>
  );
}
