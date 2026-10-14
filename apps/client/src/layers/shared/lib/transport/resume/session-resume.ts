/**
 * Pick a reopened chat's live stream up where its last connection left it
 * (DOR-2913).
 *
 * Switching away from a chat closes its stream, and switching back opened a
 * fresh one, which the server answers with a full snapshot: the newest 150
 * messages, megabytes for a long chat, though the app still held all of it.
 * The server can instead replay what happened since a cursor, so the app now
 * remembers each chat stream's last cursor and resumes from it, as long as it
 * still holds that chat's state to replay onto. Too old a cursor costs
 * nothing: the server falls back to the snapshot it would have sent anyway.
 *
 * Wraps the connection factory rather than living in `StreamManager`, which
 * knows nothing about what the app still holds; the session layer says that
 * through {@link setSessionResumePolicy}.
 *
 * @module shared/lib/transport/resume/session-resume
 */
import type { CreateConnection, DurableStreamConnection } from '../stream-manager';
import { WSConnection } from '../ws-connection';

/** What the session layer answers about resuming one chat's stream. */
export interface SessionResumePolicy {
  /** Whether the app still holds this chat's state, so a replay has something to land on. */
  canResume: (sessionId: string) => boolean;
  /** A stream for this chat is about to resume rather than start from a snapshot. */
  onResume: (sessionId: string) => void;
}

/** A connection that can report the cursor it would resume from. */
interface CursorConnection extends DurableStreamConnection {
  getLastEventId?(): string | null;
}

let policy: SessionResumePolicy = { canResume: () => false, onResume: () => {} };

/** Each chat stream's last cursor, by its URL (the chat and its directory). */
const cursors = new Map<string, string>();

/** The chat a session stream URL is for, or undefined for any other stream. */
const SESSION_STREAM = /\/sessions\/([^/?]+)\/events(?:\?|$)/;

/**
 * Say when a chat's stream may resume, and hear when one does.
 *
 * @param next - The session layer's answers.
 */
export function setSessionResumePolicy(next: SessionResumePolicy): void {
  policy = next;
}

/**
 * Forget every cursor for a chat, e.g. once it is removed.
 *
 * @param sessionId - The chat.
 */
export function forgetSessionResume(sessionId: string): void {
  for (const url of cursors.keys()) {
    if (url.match(SESSION_STREAM)?.[1] === sessionId) cursors.delete(url);
  }
}

/**
 * A connection factory whose chat streams resume from their last cursor.
 *
 * @param create - The factory to wrap.
 */
export function resumableConnections(create: CreateConnection): CreateConnection {
  return (url, options) => {
    const sessionId = url.match(SESSION_STREAM)?.[1];
    if (!sessionId) return create(url, options);
    const cursor = cursors.get(url);
    const resumeFrom = cursor !== undefined && policy.canResume(sessionId) ? cursor : undefined;
    if (resumeFrom !== undefined) policy.onResume(sessionId);
    const connection: CursorConnection = create(
      url,
      resumeFrom === undefined ? options : { ...options, resumeFrom }
    );
    const remember = () => {
      const id = connection.getLastEventId?.();
      if (id) cursors.set(url, id);
    };
    return {
      connect: () => connection.connect(),
      disconnect: () => {
        remember();
        connection.disconnect();
      },
      destroy: () => {
        remember();
        connection.destroy();
      },
      ...(connection.enableVisibilityOptimization && {
        enableVisibilityOptimization: () => connection.enableVisibilityOptimization?.(),
      }),
    };
  };
}

/** The app's real connection factory, with resuming chat streams. */
export const createResumableWSConnection = resumableConnections(
  (url, options) => new WSConnection(url, options)
);

/**
 * Forget every cursor and the policy.
 *
 * @internal Test-only.
 */
export function resetSessionResume(): void {
  cursors.clear();
  policy = { canResume: () => false, onResume: () => {} };
}
