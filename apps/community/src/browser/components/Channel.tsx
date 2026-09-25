import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Download, MessageCircle, Paperclip, RotateCcw, X } from 'lucide-react';
import type { CommunityWireEvent } from '@dorkos/shared/community-wire';
import { describeError, download, RequestError, request, tenantApiPath, upload } from '../api.js';
import type { Channel as ChannelType, Entry } from '../types.js';
import { ReportEntryLink } from './HostLinks.js';

type Page = { entries: Entry[]; nextCursor: string | null };
type Post = { entry: Entry; cursor: string };
type Props = {
  communityId: string;
  channel: ChannelType;
  onChanged: () => void;
  readOnly?: boolean;
  /** Read-only because the host holds the community, not because its owner archived it. */
  held?: boolean;
  /** When this community's history was imported; channels from before it say so at the top. */
  importedAt?: string | null;
};
function mergeEntries(previous: Entry[], incoming: Entry[]) {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
function EntryCard({
  communityId,
  entry,
  onThread,
  threadReadOnly = false,
}: {
  communityId: string;
  entry: Entry;
  onThread?: (entry: Entry) => void;
  threadReadOnly?: boolean;
}) {
  return (
    <article className="entry">
      <div className="avatar" aria-hidden="true">
        {entry.authorDisplayName.slice(0, 1).toUpperCase()}
      </div>
      <div>
        <div className="entry-meta">
          <strong>{entry.authorDisplayName}</strong>
          <time className="small muted" dateTime={entry.createdAt}>
            {new Date(entry.createdAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        </div>
        <p className="entry-text">{entry.text}</p>
        {entry.attachments.map((attachment) => (
          <button
            className="button small mt-1 mr-2"
            type="button"
            key={attachment.id}
            onClick={() => void download(`/api/v1/attachments/${attachment.id}`, attachment.name)}
          >
            <Download size={14} />
            {attachment.name}
          </button>
        ))}
        {onThread && (
          <button className="button ghost small mt-1" type="button" onClick={() => onThread(entry)}>
            <MessageCircle size={14} /> {threadReadOnly ? 'View thread' : 'Reply in thread'}
          </button>
        )}
        <ReportEntryLink communityId={communityId} entryId={entry.id} />
      </div>
    </article>
  );
}

/** Render channel history, live events, threads and composition. */
export function ChannelView({
  communityId,
  channel,
  onChanged,
  readOnly = false,
  held = false,
  importedAt = null,
}: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [thread, setThread] = useState<Entry | null>(null);
  const [replies, setReplies] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [rejectedFile, setRejectedFile] = useState<File | null>(null);
  const [errorAction, setErrorAction] = useState<'reload' | 'retry-send' | 'remove-file' | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [livePaused, setLivePaused] = useState(false);
  // Bumped to open the live stream again after the server refused it outright.
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [readCursor, setReadCursor] = useState<string | null>(null);
  const threadRef = useRef(thread);
  const listRef = useRef<HTMLDivElement>(null);
  const activeChannelId = useRef(channel.id);
  // A reload can overlap the initial request (or a retry). Only the newest
  // history page may set pagination state, while entries themselves always
  // merge: an SSE event is newer information than a slow HTTP response.
  const historyGeneration = useRef(0);
  const threadId = thread?.id;
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);
  useEffect(() => {
    activeChannelId.current = channel.id;
    return () => {
      if (activeChannelId.current === channel.id) activeChannelId.current = '';
    };
  }, [channel.id]);
  const load = useCallback(async () => {
    const generation = ++historyGeneration.current;
    const requestedChannelId = channel.id;
    setLoading(true);
    setError('');
    try {
      const page = await request<Page>(`/api/v1/channels/${channel.id}/entries?limit=50`);
      if (
        generation !== historyGeneration.current ||
        activeChannelId.current !== requestedChannelId
      )
        return;
      setEntries((previous) => mergeEntries(previous, page.entries));
      setNextCursor(page.nextCursor);
      // Keep a cursor advanced by SSE. Moving it backward would make the next
      // read receipt describe an earlier point than the one already rendered.
      setReadCursor((current) => current ?? page.entries.at(-1)?.cursor ?? null);
    } catch (cause) {
      if (activeChannelId.current !== requestedChannelId) return;
      setError(describeError(cause));
      setErrorAction('reload');
    } finally {
      if (activeChannelId.current === requestedChannelId) setLoading(false);
    }
  }, [channel.id]);
  useEffect(() => {
    if (channel.joined) void load();
    else setLoading(false);
  }, [load, channel.joined]);
  useEffect(() => {
    if (!channel.joined || readOnly) return;
    const source = new EventSource(tenantApiPath(`/api/v1/channels/${channel.id}/events`));
    const receive = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as CommunityWireEvent;
        if (event.type === 'snapshot') {
          setLivePaused(false);
          setEntries((previous) =>
            mergeEntries(
              previous,
              event.entries.filter((entry) => !entry.parentEntryId)
            )
          );
          if (event.entries.length) setReadCursor(event.cursor);
        } else if (event.type === 'entry') {
          setLivePaused(false);
          setEntries((previous) =>
            event.entry.parentEntryId ? previous : mergeEntries(previous, [event.entry])
          );
          setReplies((previous) =>
            threadRef.current && event.entry.threadRootEntryId === threadRef.current.id
              ? mergeEntries(previous, [event.entry])
              : previous
          );
          setReadCursor(event.cursor);
          onChanged();
        } else if (event.type === 'closed' && event.reason === 'archived') {
          // The community (held or archived) or this channel became read-only. History stays;
          // refreshing the community shows why, and a release opens the stream again.
          source.close();
          onChanged();
        } else {
          setError('Your access to this channel has changed.');
          setErrorAction('reload');
          source.close();
          onChanged();
        }
      } catch {
        setError('The live connection sent an invalid update.');
        setErrorAction('reload');
      }
    };
    source.addEventListener('snapshot', receive);
    source.addEventListener('entry', receive);
    source.addEventListener('closed', receive);
    let retry: number | undefined;
    source.onerror = () => {
      // EventSource reconnects on its own. A later snapshot or entry clears
      // this transient status, so a recovered stream never leaves a stale
      // warning covering the composer.
      setLivePaused(true);
      if (source.readyState !== EventSource.CLOSED) return;
      // A refused open (a hold answers 423) is final for EventSource, which never retries it.
      // Refresh the community once so a hold shows as read-only, and try the stream once a
      // minute, never in a loop; the lifecycle refresh reopens it sooner when a hold ends.
      onChanged();
      retry = window.setTimeout(() => setStreamAttempt((attempt) => attempt + 1), 60_000);
    };
    return () => {
      source.close();
      window.clearTimeout(retry);
    };
  }, [channel.id, channel.joined, onChanged, readOnly, streamAttempt]);
  useEffect(() => {
    if (!threadId) return;
    let active = true;
    void request<Page>(`/api/v1/channels/${channel.id}/entries?thread=${threadId}&limit=100`)
      .then((page) => {
        if (active) setReplies(page.entries.filter((entry) => entry.id !== threadId));
      })
      .catch((cause: unknown) => {
        if (active) setError(describeError(cause));
      });
    return () => {
      active = false;
    };
  }, [threadId, channel.id]);
  useEffect(() => {
    if (!readCursor || !channel.joined) return;
    const timer = window.setTimeout(() => {
      void request(`/api/v1/channels/${channel.id}/read-cursor`, 'PUT', { cursor: readCursor })
        .then(onChanged)
        .catch(() => {});
    }, 450);
    return () => window.clearTimeout(timer);
  }, [readCursor, channel.id, channel.joined, onChanged]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);
  async function older() {
    if (!nextCursor) return;
    try {
      const page = await request<Page>(
        `/api/v1/channels/${channel.id}/entries?limit=50&cursor=${encodeURIComponent(nextCursor)}`
      );
      setEntries((previous) => mergeEntries(page.entries, previous));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(describeError(cause));
      setErrorAction('reload');
    }
  }
  async function submit() {
    if (!text.trim() && files.length === 0) return;
    setBusy(true);
    setError('');
    const key = pendingKey ?? crypto.randomUUID();
    setPendingKey(key);
    let uploadingFile: File | null = null;
    try {
      const attachmentIds: string[] = [];
      for (const file of files) {
        uploadingFile = file;
        attachmentIds.push(
          await upload(channel.id, file, `${key}:${attachmentIds.length}`, setProgress)
        );
      }
      const body = {
        text: text.trim() || 'Shared a file',
        parentEntryId: thread?.id,
        idempotencyKey: key,
        attachmentIds,
      };
      const posted = await request<Post>(`/api/v1/channels/${channel.id}/entries`, 'POST', body);
      if (thread) setReplies((previous) => mergeEntries(previous, [posted.entry]));
      else setEntries((previous) => mergeEntries(previous, [posted.entry]));
      setText('');
      setFiles([]);
      setPendingKey(null);
      setProgress(null);
      setRejectedFile(null);
      setErrorAction(null);
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
      setProgress(null);
      if (
        cause instanceof RequestError &&
        (cause.status === 413 || cause.status === 415) &&
        uploadingFile
      ) {
        setRejectedFile(uploadingFile);
        setErrorAction('remove-file');
      } else if (
        cause instanceof RequestError &&
        (cause.status === 0 || cause.status === 429 || cause.status === 503)
      )
        setErrorAction('retry-send');
      else setErrorAction(null);
    } finally {
      setBusy(false);
    }
  }
  async function join() {
    try {
      await request(`/api/v1/channels/${channel.id}/join`, 'POST', {});
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
      setErrorAction('reload');
    }
  }
  function chooseFiles(list: FileList | null) {
    if (!list) return;
    const selected = Array.from(list);
    if (selected.length + files.length > 4) {
      setError('Add up to four files to one message.');
      setErrorAction(null);
      return;
    }
    if (selected.some((file) => file.size > 10 * 1024 * 1024)) {
      setError('Each file must be 10 MB or smaller.');
      setErrorAction(null);
      return;
    }
    setFiles((previous) => [...previous, ...selected]);
    setPendingKey(null);
    setRejectedFile(null);
    setErrorAction(null);
  }
  if (!channel.joined)
    return (
      <div className="settings">
        <div className="panel p-8">
          <p className="eyebrow">Public channel</p>
          <h2>#{channel.name}</h2>
          <p className="muted">
            {channel.description ?? 'Join to read and take part in this channel.'}
          </p>
          {readOnly ? (
            <p className="notice mb-0">
              {held ? 'While this community is on hold, history' : 'Archived history'} is available
              only for channels you joined.
            </p>
          ) : (
            <button className="button primary" onClick={() => void join()}>
              Join channel <ArrowUp size={16} />
            </button>
          )}
          {error && (
            <div className="notice error mt-4" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  return (
    <div className={`channel-view ${thread ? 'thread-open' : ''}`}>
      <div ref={listRef} className="message-list" aria-live="polite">
        {loading ? (
          <p className="muted" role="status">
            Loading messages…
          </p>
        ) : (
          <>
            {nextCursor && (
              <div className="text-center">
                <button className="button" onClick={() => void older()}>
                  Load older messages
                </button>
              </div>
            )}
            {!nextCursor && importedAt && channel.createdAt <= importedAt && (
              <p className="small muted text-center" role="note">
                History imported from another host on {new Date(importedAt).toLocaleDateString()}.
              </p>
            )}
            {entries.length === 0 && (
              <div className="pt-12 text-center">
                <MessageCircle size={30} className="mx-auto mb-3 text-[var(--accent)]" />
                <h3>A quiet start.</h3>
                <p className="muted">Say hello to begin the conversation.</p>
              </div>
            )}
            {entries.map((entry) => (
              <EntryCard
                key={entry.id}
                communityId={communityId}
                entry={entry}
                onThread={setThread}
                threadReadOnly={readOnly}
              />
            ))}
          </>
        )}
        {(error || (livePaused && !readOnly)) && (
          <div role="alert" className="notice error row mt-3">
            {error || 'Live updates paused. Reconnecting…'}
            {errorAction === 'remove-file' && rejectedFile ? (
              <>
                <span className="small">
                  Remove the rejected file, then choose a supported file.
                </span>
                <button
                  className="button"
                  onClick={() => {
                    setFiles((previous) => previous.filter((file) => file !== rejectedFile));
                    setRejectedFile(null);
                    setPendingKey(null);
                    setError('');
                    setErrorAction(null);
                  }}
                >
                  Remove rejected file
                </button>
              </>
            ) : errorAction === 'retry-send' ? (
              <button className="button" onClick={() => void submit()}>
                <RotateCcw size={14} /> Retry sending
              </button>
            ) : errorAction === 'reload' ? (
              <button className="button" onClick={() => void load()}>
                <RotateCcw size={14} /> Retry
              </button>
            ) : null}
          </div>
        )}
      </div>
      {readOnly ? (
        <div className="composer" role="status">
          <p className="mb-0">
            {held
              ? 'This community is on hold by its host, so no one can post.'
              : 'Archived history is read-only. Restore the community to post again.'}
          </p>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="message" className="sr-only">
            Message #{channel.name}
          </label>
          <textarea
            id="message"
            placeholder={channel.archived ? 'This channel is archived' : `Message #${channel.name}`}
            disabled={channel.archived || busy}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (pendingKey) setPendingKey(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {files.length > 0 && (
            <div className="row mt-2">
              {files.map((file, index) => (
                <span key={`${file.name}:${index}`} className="badge">
                  {file.name}{' '}
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => {
                      setFiles((old) => old.filter((_, i) => i !== index));
                      if (file === rejectedFile) {
                        setRejectedFile(null);
                        setErrorAction(null);
                      }
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {progress !== null && (
            <p role="status" className="small muted">
              Uploading {progress}%
            </p>
          )}
          <div className="composer-foot">
            <label className="button" aria-label="Add files">
              <Paperclip size={17} /> Attach
              <input
                type="file"
                multiple
                className="sr-only"
                disabled={busy || channel.archived}
                onChange={(event) => {
                  chooseFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
            <button
              className="button primary"
              disabled={busy || channel.archived || (!text.trim() && !files.length)}
            >
              {busy ? 'Sending…' : 'Send'}
              <ArrowUp size={17} />
            </button>
          </div>
        </form>
      )}
      {thread && (
        <>
          <button
            className="thread-scrim"
            aria-label="Close thread"
            onClick={() => setThread(null)}
          />
          <aside className="drawer" aria-label="Thread">
            <div className="drawer-head row">
              <button
                className="button ghost"
                onClick={() => setThread(null)}
                aria-label="Close thread"
              >
                <ArrowLeft size={18} />
              </button>
              <strong>Thread</strong>
              <button
                className="button ghost ml-auto"
                onClick={() => setThread(null)}
                aria-label="Close thread"
              >
                <X size={18} />
              </button>
            </div>
            <div className="drawer-content">
              <EntryCard communityId={communityId} entry={thread} />
              <hr className="divider" />
              {replies.map((entry) => (
                <EntryCard key={entry.id} communityId={communityId} entry={entry} />
              ))}
              {replies.length === 0 && <p className="muted small">No replies yet.</p>}
            </div>
            {readOnly ? (
              <div className="composer" role="status">
                <p className="mb-0">
                  {held
                    ? 'Threads are read-only while on hold.'
                    : 'Archived threads are read-only.'}
                </p>
              </div>
            ) : (
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <label htmlFor="reply" className="sr-only">
                  Reply in thread
                </label>
                <textarea
                  id="reply"
                  placeholder="Reply in thread"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  disabled={busy || channel.archived}
                />
                <div className="composer-foot">
                  <span className="small muted">Replies stay in this thread.</span>
                  <button
                    className="button primary"
                    disabled={busy || !text.trim() || channel.archived}
                  >
                    Reply <ArrowUp size={16} />
                  </button>
                </div>
              </form>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
