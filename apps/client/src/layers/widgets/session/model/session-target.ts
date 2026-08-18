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
import { useMemo } from 'react';
import type {
  ConversationAttachmentPort,
  ConversationDraft,
  ConversationTarget,
} from '@/layers/features/conversation';
import type { PendingFile } from '@/layers/features/composer';

/** The parts of the session's own machinery this adapter writes through. */
export interface SessionTargetInput {
  /** The session being written to. */
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
   */
  submit: (content: string) => void;
  /** Hold these words for the current turn instead. Resolves once the server has them. */
  enqueue: (content: string) => Promise<boolean>;
  /** How many messages are genuinely waiting on the server's queue. */
  queueDepth: number;
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
 * @param input - The session's own send path, queue and staged files.
 * @returns The target the conversation publishes to its composer.
 */
export function useSessionTarget(input: SessionTargetInput): ConversationTarget {
  const { sessionId, placeholder, submit, enqueue, queueDepth, files } = input;

  const attachments = useMemo<ConversationAttachmentPort>(
    () => ({
      staged: files.pendingFiles,
      add: files.addFiles,
      remove: files.removeFile,
      retry: files.retryFile,
      cancel: files.cancelUpload,
      hasFailed: files.hasFailedUpload,
      isUploading: files.isUploading,
    }),
    [files]
  );

  return useMemo<ConversationTarget>(
    () => ({
      kind: 'session',
      id: sessionId,
      placeholder,
      // A session with no id yet is one this browser is about to create with its
      // first message, which is exactly when somebody types into it — so the
      // only thing that closes this box is a failed attachment, and the composer
      // reads that off the port.
      canSend: true,
      send(draft: ConversationDraft): Promise<void> {
        // Synchronous by design: `submit` starts a turn and the words come back
        // on the stream. Wrapping the throw is what makes a refusal surface
        // rather than disappear — the interface promises a rejection, never a
        // silent drop.
        try {
          submit(draft.text);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      async queue(draft: ConversationDraft): Promise<void> {
        const held = await enqueue(draft.text);
        // `false` means the server did not take it. The composer keeps the words
        // on a rejection, so this must be one rather than a quiet no-op.
        if (!held) throw new Error('The queue did not accept that message.');
      },
      queueDepth,
      attachments,
    }),
    [sessionId, placeholder, submit, enqueue, queueDepth, attachments]
  );
}
