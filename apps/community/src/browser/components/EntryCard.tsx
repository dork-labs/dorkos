import { Button, Notice } from '@dork-labs/ui';
import { useId, useRef, useState } from 'react';
import { Bot, Download, MessageCircle } from 'lucide-react';
import { download } from '../api.js';
import { isRemovedEntry, REMOVAL_COPY, type RemovalAction } from '../entry-removal.js';
import { threadRepliesLabel, type ThreadReplies } from '../threads/thread-replies.js';
import type { Entry } from '../types.js';
import { ReportEntryLink, ReportFileLink } from './HostLinks.js';
import {
  RemovalConfirmation,
  RemovalMenu,
  type RemovalRequest,
  type RemovalTarget,
} from './EntryRemoval.js';

/** What a message card may do beyond reading: open its thread, and delete or remove it. */
export type EntryControls = {
  /** Delete (own) or Remove (moderator), or null when the viewer may do neither. */
  action: RemovalAction | null;
  onRemove: (entry: Entry, request: RemovalRequest) => void;
  /** The server's sentence from the last removal this message refused. */
  error?: string;
};

/**
 * One message: its author, text or tombstone, files, thread link and reply count, and delete or
 * remove menu.
 *
 * An agent's message is marked the way the DorkOS app marks one: a filled square avatar with a
 * small bot badge, where a person's is a tinted circle. The badge is decoration; the message's
 * accessible name says "Agent" after the name instead, so a screen reader hears it once, in the
 * same place a sighted reader sees it.
 */
export function EntryCard({
  communityId,
  entry,
  controls,
  onThread,
  threadReadOnly = false,
  replies,
}: {
  communityId: string;
  entry: Entry;
  controls: EntryControls;
  onThread?: (entry: Entry) => void;
  threadReadOnly?: boolean;
  /** The reply line under a thread root, when it has replies. */
  replies?: ThreadReplies;
}) {
  const [confirming, setConfirming] = useState<RemovalRequest | null>(null);
  const card = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const tombstone = isRemovedEntry(entry);
  const authorId = useId();
  const kindId = useId();
  const timeId = useId();
  const agent = entry.authorKind === 'agent';
  const time = new Date(entry.createdAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const { action } = controls;
  const replyTime = replies
    ? new Date(replies.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  function confirm(
    target: RemovalTarget,
    chosen: RemovalAction,
    trigger: HTMLButtonElement | null
  ) {
    returnFocus.current = trigger;
    setConfirming({ target, action: chosen });
  }
  return (
    <article
      className="entry"
      ref={card}
      tabIndex={-1}
      aria-labelledby={agent ? `${authorId} ${kindId} ${timeId}` : `${authorId} ${timeId}`}
    >
      <div className={agent ? 'avatar agent' : 'avatar'} aria-hidden="true">
        {entry.authorDisplayName.slice(0, 1).toUpperCase()}
        {agent && (
          <span className="avatar-badge" data-testid="agent-badge">
            <Bot size={12} strokeWidth={2.25} />
          </span>
        )}
      </div>
      <div className="min-w-0">
        <div className="entry-meta">
          <strong id={authorId}>{entry.authorDisplayName}</strong>
          {agent && (
            <span id={kindId} className="sr-only">
              Agent
            </span>
          )}
          <time id={timeId} className="small muted" dateTime={entry.createdAt}>
            {time}
          </time>
          {action && (
            <RemovalMenu
              className="entry-actions"
              label={`Message actions: ${entry.authorDisplayName}, ${time}`}
              itemLabel={REMOVAL_COPY.message[action].menuItem}
              onChoose={(trigger) => confirm({ kind: 'message' }, action, trigger)}
            />
          )}
        </div>
        <p className={`entry-text ${tombstone ? 'tombstone' : ''}`}>{entry.text}</p>
        {entry.attachments.map((attachment) => (
          <span className="file-chip mt-1 mr-2" key={attachment.id}>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void download(`/api/v1/attachments/${attachment.id}`, attachment.name)}
            >
              <Download size={14} aria-hidden="true" />
              {attachment.name}
            </Button>
            <ReportFileLink
              communityId={communityId}
              entryId={entry.id}
              attachmentId={attachment.id}
              fileName={attachment.name}
            />
            {action && (
              <RemovalMenu
                label={`Actions for ${attachment.name}`}
                itemLabel={REMOVAL_COPY.file[action].menuItem}
                onChoose={(trigger) => confirm({ kind: 'file', attachment }, action, trigger)}
              />
            )}
          </span>
        ))}
        {controls.error && (
          <Notice tone="error" className="mt-2" role="alert">
            {controls.error}
          </Notice>
        )}
        {onThread && (
          <div className="thread-actions">
            {replies && (
              <Button
                variant="ghost"
                size="sm"
                className="thread-replies"
                type="button"
                data-testid="thread-replies"
                onClick={() => onThread(entry)}
              >
                <span aria-hidden="true">↳</span>
                {threadRepliesLabel(replies, replyTime)}
              </Button>
            )}
            <Button variant="ghost" size="sm" type="button" onClick={() => onThread(entry)}>
              <MessageCircle size={14} /> {threadReadOnly ? 'View thread' : 'Reply in thread'}
            </Button>
          </div>
        )}
        {!tombstone && <ReportEntryLink communityId={communityId} entryId={entry.id} />}
      </div>
      <RemovalConfirmation
        request={confirming}
        returnFocus={returnFocus}
        settle={card}
        onConfirm={(request) => controls.onRemove(entry, request)}
        onClose={() => setConfirming(null)}
      />
    </article>
  );
}
