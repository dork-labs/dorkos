import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Download, MessageCircle, Paperclip, RotateCcw, X } from 'lucide-react';
import type { CommunityWireEvent } from '@dorkos/shared/community-wire';
import { describeError, download, RequestError, request, upload } from '../api.js';
import type { Channel as ChannelType, Entry } from '../types.js';

type Page = { entries: Entry[]; nextCursor: string | null };
type Post = { entry: Entry; cursor: string };
type Props = { channel: ChannelType; onChanged: () => void };
function mergeEntries(previous: Entry[], incoming: Entry[]) {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
function EntryCard({ entry, onThread }: { entry: Entry; onThread?: (entry: Entry) => void }) {
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
            <MessageCircle size={14} /> Reply in thread
          </button>
        )}
      </div>
    </article>
  );
}

/** Render channel history, live events, threads and composition. */
export function ChannelView({ channel, onChanged }: Props) {
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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [readCursor, setReadCursor] = useState<string | null>(null);
  const threadRef = useRef(thread);
  const listRef = useRef<HTMLDivElement>(null);
  const threadId = thread?.id;
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const page = await request<Page>(`/api/v1/channels/${channel.id}/entries?limit=50`);
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
      setReadCursor(page.entries.at(-1)?.cursor ?? null);
    } catch (cause) {
      setError(describeError(cause));
      setErrorAction('reload');
    } finally {
      setLoading(false);
    }
  }, [channel.id]);
  useEffect(() => {
    if (channel.joined) void load();
    else setLoading(false);
  }, [load, channel.joined]);
  useEffect(() => {
    if (!channel.joined) return;
    const source = new EventSource(`/api/v1/channels/${channel.id}/events`);
    const receive = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as CommunityWireEvent;
        if (event.type === 'snapshot') {
          setEntries((previous) =>
            mergeEntries(
              previous,
              event.entries.filter((entry) => !entry.parentEntryId)
            )
          );
          if (event.entries.length) setReadCursor(event.cursor);
        } else if (event.type === 'entry') {
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
    source.onerror = () => {
      setError('Live updates paused. Reconnecting…');
      setErrorAction('reload');
    };
    return () => source.close();
  }, [channel.id, channel.joined, onChanged]);
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
          <button className="button primary" onClick={() => void join()}>
            Join channel <ArrowUp size={16} />
          </button>
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
            {entries.length === 0 && (
              <div className="pt-12 text-center">
                <MessageCircle size={30} className="mx-auto mb-3 text-[var(--accent)]" />
                <h3>A quiet start.</h3>
                <p className="muted">Say hello to begin the conversation.</p>
              </div>
            )}
            {entries.map((entry) => (
              <EntryCard key={entry.id} entry={entry} onThread={setThread} />
            ))}
          </>
        )}
        {error && (
          <div role="alert" className="notice error row mt-3">
            {error}
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
              <EntryCard entry={thread} />
              <hr className="divider" />
              {replies.map((entry) => (
                <EntryCard key={entry.id} entry={entry} />
              ))}
              {replies.length === 0 && <p className="muted small">No replies yet.</p>}
            </div>
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
          </aside>
        </>
      )}
    </div>
  );
}
