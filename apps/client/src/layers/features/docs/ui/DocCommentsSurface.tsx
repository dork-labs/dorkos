import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { BlintzPlugin } from 'blintz';
import { useBlintzComments, type CommentAnchor } from '@blintz/comments';
import type {
  DocCommentAnchor,
  DocCommentUnreached,
  DocCommentThread,
  DocRef,
} from '@dorkos/shared/doc-comments';
import {
  useCreateDocCommentThread,
  useDocCommentMentionable,
  useDocCommentThreads,
  useEditDocComment,
  useReplyDocComment,
  useSetDocCommentThreadResolved,
  useUpdateDocCommentAnchors,
} from '@/layers/entities/doc';
import { Button, Label, Switch } from '@/layers/shared/ui';
import { unreachedNote, type ThreadPlacement } from '../lib/comment-copy';
import { DocCommentComposer } from './DocCommentComposer';
import { DocCommentThreadCard } from './DocCommentThreadCard';
import './doc-comments.css';

/** Props for {@link DocCommentsSurface}. */
export interface DocCommentsSurfaceProps {
  /** The file-backed markdown doc. */
  doc: DocRef;
  /** The editor, handed the comment plugin to install. */
  children: (plugins: BlintzPlugin[]) => ReactNode;
}

const NO_THREADS: DocCommentThread[] = [];

/** What the panel says when a write did not reach the server. */
const SAVE_FAILED = 'Couldn’t save the comment. Try again.';

/** What the panel says after a write: who it could not wake, or nothing. */
function noticeOf(unreached: readonly DocCommentUnreached[]): string | null {
  return unreached.length > 0 ? unreached.map(unreachedNote).join(' ') : null;
}

/**
 * A doc with its comments: the editor (highlighting every thread's words) and
 * a panel beside it, or under it in a narrow pane, listing the threads.
 *
 * Select words and press Comment to open a thread. Clicking a highlight
 * brings its thread forward; clicking a thread shows its words. A thread
 * whose words now appear in several places says so, and one whose words were
 * removed stays listed, marked.
 */
export function DocCommentsSurface({ doc, children }: DocCommentsSurfaceProps) {
  const threads = useDocCommentThreads(doc).data ?? NO_THREADS;
  const mentionable = useDocCommentMentionable().data ?? [];
  const create = useCreateDocCommentThread(doc);
  const reply = useReplyDocComment(doc);
  const setResolved = useSetDocCommentThreadResolved(doc);
  const edit = useEditDocComment(doc);
  const saveAnchors = useUpdateDocCommentAnchors(doc);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [orphaned, setOrphaned] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<DocCommentAnchor | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The editor places threads after it renders; a second look a frame later
  // reads where it put them, so a thread that landed ambiguously says so.
  const [, setPlacedAt] = useState(0);

  const refs = useMemo(
    () =>
      threads.map((thread) => ({
        id: thread.id,
        anchor: thread.anchor as unknown as CommentAnchor,
        resolved: thread.resolved,
      })),
    [threads]
  );

  const comments = useBlintzComments({
    threads: refs,
    activeThreadId: activeId,
    showResolved,
    onThreadClick: (ids) => setActiveId(ids[0] ?? null),
    onAnchorsChange: (updates) =>
      saveAnchors.mutate(
        updates.map(({ id, anchor }) => ({ id, anchor: anchor as unknown as DocCommentAnchor }))
      ),
    onOrphanedChange: (ids) => setOrphaned(new Set(ids)),
  });
  const plugins = useMemo(() => [comments.plugin], [comments.plugin]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlacedAt(Date.now()));
    return () => cancelAnimationFrame(frame);
  }, [refs, orphaned]);

  const placementOf = (id: string): ThreadPlacement =>
    orphaned.has(id) ? 'orphaned' : (comments.rangeOf(id)?.match ?? 'exact');

  const visible = threads.filter((thread) => showResolved || !thread.resolved);
  const resolvedCount = threads.length - threads.filter((thread) => !thread.resolved).length;

  const startComment = () => {
    const anchor = comments.anchorSelection();
    if (!anchor) {
      setNotice('Select some text in the doc first.');
      return;
    }
    setNotice(null);
    setPending({ ...anchor });
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

  const activate = (id: string) => {
    setActiveId(id);
    comments.reveal(id);
  };

  return (
    <div className="@container">
      <div className="flex flex-col gap-4 @3xl:flex-row">
        <div className="min-w-0 flex-1">{children(plugins)}</div>
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
              // Keeps the editor's selection: a press that took focus first
              // would leave nothing selected to comment on.
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
                onCheckedChange={setShowResolved}
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
                setActiveId(result.thread.id);
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
                  onActivate={() => activate(thread.id)}
                  onReply={async (body) => {
                    const result = await saving(() =>
                      reply.mutateAsync({ threadId: thread.id, body })
                    );
                    setNotice(noticeOf(result.unreached));
                  }}
                  onSetResolved={(resolved) =>
                    setResolved.mutate({ threadId: thread.id, resolved })
                  }
                  onEdit={(commentId, body) =>
                    saving(() => edit.mutateAsync({ threadId: thread.id, commentId, body }))
                  }
                />
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
