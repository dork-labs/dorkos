import { useRef, useState } from 'react';
import { Download, MessageCircle } from 'lucide-react';
import { isTombstoneText } from '../../content/tombstones.js';
import { download } from '../api.js';
import { REMOVAL_COPY, type RemovalAction } from '../entry-removal.js';
import type { Entry } from '../types.js';
import { ReportEntryLink } from './HostLinks.js';
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

/** One message: its author, text or tombstone, files, thread link, and delete or remove menu. */
export function EntryCard({
  communityId,
  entry,
  controls,
  onThread,
  threadReadOnly = false,
}: {
  communityId: string;
  entry: Entry;
  controls: EntryControls;
  onThread?: (entry: Entry) => void;
  threadReadOnly?: boolean;
}) {
  const [confirming, setConfirming] = useState<RemovalRequest | null>(null);
  const card = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const tombstone = isTombstoneText(entry.text);
  const { action } = controls;
  function confirm(
    target: RemovalTarget,
    chosen: RemovalAction,
    trigger: HTMLButtonElement | null
  ) {
    returnFocus.current = trigger;
    setConfirming({ target, action: chosen });
  }
  return (
    <article className="entry" ref={card} tabIndex={-1}>
      <div className="avatar" aria-hidden="true">
        {entry.authorDisplayName.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="entry-meta">
          <strong>{entry.authorDisplayName}</strong>
          <time className="small muted" dateTime={entry.createdAt}>
            {new Date(entry.createdAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
          {action && (
            <RemovalMenu
              className="entry-actions"
              label="Message actions"
              itemLabel={REMOVAL_COPY.message[action].menuItem}
              onChoose={(trigger) => confirm({ kind: 'message' }, action, trigger)}
            />
          )}
        </div>
        <p className={`entry-text ${tombstone ? 'tombstone' : ''}`}>{entry.text}</p>
        {entry.attachments.map((attachment) => (
          <span className="file-chip mt-1 mr-2" key={attachment.id}>
            <button
              className="button small"
              type="button"
              onClick={() => void download(`/api/v1/attachments/${attachment.id}`, attachment.name)}
            >
              <Download size={14} aria-hidden="true" />
              {attachment.name}
            </button>
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
          <div className="notice error mt-2" role="alert">
            {controls.error}
          </div>
        )}
        {onThread && (
          <button className="button ghost small mt-1" type="button" onClick={() => onThread(entry)}>
            <MessageCircle size={14} /> {threadReadOnly ? 'View thread' : 'Reply in thread'}
          </button>
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
