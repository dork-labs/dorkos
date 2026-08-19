/**
 * Where a session's words go — `ConversationTarget`, implemented for a session.
 *
 * One of two adapters, and they live in the HOST WIDGETS rather than in
 * `features/conversation` on purpose: the neutral tree must not know how either
 * surface sends. What it knows is that it can send, whether it may right now,
 * whether there is a queue behind it, and what files are staged.
 *
 * @module widgets/session/model/session-target
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  ConversationAttachmentPort,
  ConversationDraft,
  ConversationTarget,
} from '@/layers/features/conversation';
import type { PendingFile } from '@/layers/features/composer';

/** The parts of the session's own machinery this adapter writes through. */
export interface SessionTargetInput {
  /**
   * The session being written to, or `''` before one has been resolved.
   *
   * Empty is a real state rather than a defensive default: the Obsidian embed
   * seeds no session id until one is opened, and `/session` can be rendered
   * while its loader is still deciding which conversation that is. Neither
   * delivery path below can do anything with it, so {@link ConversationTarget.canSend}
   * says so instead of letting a message go nowhere.
   */
  sessionId: string;
  /** What the empty box says — "Message DorkBot…". */
  placeholder: string;
  /**
   * Start a turn with these words.
   *
   * `POST /api/sessions/:id/messages` is trigger-only (202) and delivery rides
   * the durable per-session SSE stream (ADR-0264), so this must NOT wait for
   * content: it resolves when the server has accepted the trigger, and the words
   * appear because the stream says so.
   *
   * It also owns the composer's clear, which is why the host does not take the
   * draft out of the box first the way a room's does: the words are emptied only
   * once the attachment transform has succeeded, so a failed upload leaves them
   * exactly where they were typed (DOR-480).
   */
  submit: (content: string) => Promise<void> | void;
  /** Hold these words for the current turn instead. Resolves once the server has them. */
  enqueue: (content: string) => Promise<boolean>;
  /** The staged files, and what can be done to them. */
  files: {
    pendingFiles: PendingFile[];
    addFiles: (files: File[]) => void;
    removeFile: (id: string) => void;
    retryFile: (id: string) => void;
    cancelUpload: () => void;
    hasFailedUpload: boolean;
    isUploading: boolean;
  };
}

/**
 * Adapt a session to the one thing a composer needs.
 *
 * **A session has a queue, and that is the whole difference from a room.**
 * `queue` is present here and absent there, which is what makes the composer
 * draw queue chrome on one surface and none at all on the other — rather than a
 * disabled button explaining a feature the surface does not have.
 *
 * **`send` and `queue` ARE the session's live path** (DOR-1354, closing P4's
 * Known Issue 28). Pressing Enter in a session lands in `send` and pressing it
 * mid-turn lands in `queue`, exactly as a channel's Enter lands in the room
 * target's `send`. What stays in `SessionComposer` is the same thing that stays
 * in `ChannelComposer` — the surface's own funnel, which dismisses its palettes,
 * intercepts a native command and holds a duplicate press — and it ENDS here.
 *
 * @param input - The session's own send path, queue and staged files.
 * @returns The target the conversation publishes to its composer.
 */
export function useSessionTarget(input: SessionTargetInput): ConversationTarget {
  const { sessionId, placeholder, files } = input;

  /**
   * What the port's actions, `send` and `queue` read at the moment they RUN.
   *
   * The target is the conversation's context value, so anything that churns its
   * identity re-renders the entire transcript — once per streamed token, which
   * is exactly what virtualizing the list was for. `files` is a fresh literal
   * every render, and the two send paths come down as fresh closures. None of
   * them is read while rendering, so they are read from here when somebody
   * presses Enter instead, and the memos below depend only on facts that
   * genuinely change.
   */
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  const add = useCallback((toAdd: File[]) => latest.current.files.addFiles(toAdd), []);
  const remove = useCallback((fileId: string) => latest.current.files.removeFile(fileId), []);
  const retry = useCallback((fileId: string) => latest.current.files.retryFile(fileId), []);
  const cancel = useCallback(() => latest.current.files.cancelUpload(), []);

  const { pendingFiles, hasFailedUpload, isUploading } = files;
  const attachments = useMemo<ConversationAttachmentPort>(
    () => ({
      staged: pendingFiles,
      add,
      remove,
      retry,
      cancel,
      hasFailed: hasFailedUpload,
      isUploading,
      // A session's send rewrites the message with the SAVED PATHS, so it
      // cannot go out until the files have landed. Enter waits, and Escape
      // offers to abandon the upload.
      holdsSendWhileUploading: true,
    }),
    [pendingFiles, hasFailedUpload, isUploading, add, remove, retry, cancel]
  );

  const send = useCallback(async (draft: ConversationDraft): Promise<void> => {
    // Resolves on the TRIGGER, not on the answer: `submit` returns once the
    // server has accepted the turn, and the words come back on the stream. A
    // throw propagates rather than being swallowed — the interface promises a
    // rejection, never a silent drop.
    await latest.current.submit(draft.text);
  }, []);

  const queue = useCallback(async (draft: ConversationDraft): Promise<void> => {
    const held = await latest.current.enqueue(draft.text);
    // `false` means the server did not take it. The composer keeps the words
    // on a rejection, so this must be one rather than a quiet no-op.
    if (!held) throw new Error('The queue did not accept that message.');
  }, []);

  return useMemo<ConversationTarget>(
    () => ({
      kind: 'session',
      id: sessionId,
      placeholder,
      // A session this browser is about to create already HAS an id — it is
      // minted client-side and the first message is what makes it real on the
      // server — so an empty one is not "new", it is "not resolved yet". Both
      // delivery paths refuse it outright (the queue POST returns `false`
      // without asking, and the trigger has no session to address), so the box
      // says so rather than eating a message. Same sentence the room target
      // uses for its own still-loading case, because it is the same state.
      canSend: sessionId !== '',
      ...(sessionId === '' ? { canSendReason: 'Still opening this conversation…' } : {}),
      send,
      queue,
      attachments,
    }),
    [sessionId, placeholder, attachments, send, queue]
  );
}
