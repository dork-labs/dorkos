import { useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import type {
  DocComment,
  DocCommentMentionable,
  DocCommentThread,
} from '@dorkos/shared/doc-comments';
import { cn, formatRelativeTime, resolveIdentityFace } from '@/layers/shared/lib';
import { Button, IdentityAvatar } from '@/layers/shared/ui';
import { placementNote, type ThreadPlacement } from '../lib/comment-copy';
import { DocCommentComposer } from './DocCommentComposer';

/** Props for {@link DocCommentThreadCard}. */
export interface DocCommentThreadCardProps {
  /** The thread. */
  thread: DocCommentThread;
  /** How the editor placed it in the text now. */
  placement: ThreadPlacement;
  /** Whether it is the one emphasized in the doc. */
  active: boolean;
  /** Everybody a reply can mention. */
  mentionable: readonly DocCommentMentionable[];
  /** Emphasize this thread and show its words in the doc. */
  onActivate: () => void;
  /** Reply in the thread. */
  onReply: (body: string) => Promise<unknown>;
  /** Mark it done, or open it again. */
  onSetResolved: (resolved: boolean) => void;
  /** Change one of the owner's own comments. */
  onEdit: (commentId: string, body: string) => Promise<unknown>;
}

/** One comment: who wrote it, when, and what it says. */
function CommentRow({
  comment,
  onEdit,
  mentionable,
}: {
  comment: DocComment;
  onEdit: (body: string) => Promise<unknown>;
  mentionable: readonly DocCommentMentionable[];
}) {
  const [editing, setEditing] = useState(false);
  const face = resolveIdentityFace({
    record: {
      id: comment.author.id,
      kind: comment.author.kind,
      displayName: comment.author.displayName,
      ...(comment.author.emoji ? { emoji: comment.author.emoji } : {}),
      ...(comment.author.color ? { color: comment.author.color } : {}),
    },
  });
  return (
    <li className="group/comment flex gap-2">
      <IdentityAvatar
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        fallback={face.fallback}
        size="xs"
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-xs">
          <span className="text-foreground truncate font-medium">
            {comment.author.isOwner ? 'You' : comment.author.displayName}
          </span>
          <time className="text-muted-foreground shrink-0" dateTime={comment.createdAt}>
            {formatRelativeTime(comment.createdAt)}
          </time>
          {comment.editedAt && <span className="text-muted-foreground">· edited</span>}
          {comment.author.isOwner && !editing && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground ml-auto opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
        </div>
        {editing ? (
          <DocCommentComposer
            mentionable={mentionable}
            placeholder="Edit your comment"
            submitLabel="Save"
            initialValue={comment.body}
            focusOnMount
            onSubmit={async (body) => {
              await onEdit(body);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <p className="text-foreground text-sm break-words whitespace-pre-wrap">{comment.body}</p>
        )}
      </div>
    </li>
  );
}

/**
 * One thread beside the doc: the words it is on, its comments, a reply box,
 * and resolve or reopen. Says so when its words moved to a place that may be
 * wrong, or were removed.
 */
export function DocCommentThreadCard({
  thread,
  placement,
  active,
  mentionable,
  onActivate,
  onReply,
  onSetResolved,
  onEdit,
}: DocCommentThreadCardProps) {
  const [replying, setReplying] = useState(false);
  const quote = typeof thread.anchor.quote === 'string' ? thread.anchor.quote : null;
  const note = placementNote(placement);
  return (
    <article
      data-thread-id={thread.id}
      aria-label={quote ? `Comments on “${quote}”` : 'Comments'}
      className={cn(
        'bg-card rounded-lg border p-3 transition-shadow duration-200',
        active && 'ring-ring/40 ring-2',
        thread.resolved && 'opacity-80'
      )}
    >
      <div className="mb-2 flex items-start gap-2">
        <button
          type="button"
          onClick={onActivate}
          className="text-muted-foreground hover:text-foreground min-w-0 flex-1 text-left text-xs"
        >
          {quote ? (
            <span className="border-status-warning line-clamp-2 border-l-2 pl-2 italic">
              {quote}
            </span>
          ) : (
            'Show in doc'
          )}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => onSetResolved(!thread.resolved)}
        >
          {thread.resolved ? (
            <>
              <RotateCcw /> Reopen
            </>
          ) : (
            <>
              <Check /> Resolve
            </>
          )}
        </Button>
      </div>
      {note && (
        <p role="note" className="text-status-warning-fg mb-2 text-xs">
          {note}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {thread.comments.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            mentionable={mentionable}
            onEdit={(body) => onEdit(comment.id, body)}
          />
        ))}
      </ul>
      {!thread.resolved && (
        <div className="mt-3">
          {replying ? (
            <DocCommentComposer
              mentionable={mentionable}
              placeholder="Reply…"
              submitLabel="Reply"
              focusOnMount
              onSubmit={async (body) => {
                await onReply(body);
                setReplying(false);
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => setReplying(true)}
            >
              Reply
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
