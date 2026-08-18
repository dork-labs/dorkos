/**
 * A session's composer, wired the way `ChatPanel` wires it.
 *
 * `SessionComposer` reads its target off `Conversation.Root` — that is where
 * the placeholder, the queue's depth and the staged files come from — so a
 * bench that mounted the composer bare would be testing a shape the app never
 * renders. This builds the same target from the same inputs the host has.
 *
 * Shared from here rather than duplicated in four suites, all of which need the
 * identical wiring around a component they otherwise vary one prop of.
 *
 * @module test-helpers/session-composer
 */
import { useMemo, type ComponentProps } from 'react';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import type { PendingFile } from '@/layers/features/composer';
import { useSessionQueue, useSessionStreamLifecycle } from '@/layers/entities/session';
import { selectWaitingQueue } from '@/layers/features/chat';
import { Conversation } from '@/layers/features/conversation';
import { SESSION_CAPABILITIES, SessionComposer, useSessionTarget } from '@/layers/widgets/session';

/** The staged files, in the shape a host's `useFileUpload` reports them. */
interface BenchFileUpload {
  /** Files staged against the draft. */
  pendingFiles: PendingFile[];
  /** Stage more. */
  onFilesSelected: (files: File[]) => void;
  /** Drop one. */
  onFileRemove: (id: string) => void;
  /** Try a failed one again. */
  onFileRetry: (id: string) => void;
  /** Abandon the upload in flight. */
  onUploadCancel: () => void;
  /** True while bytes are going up. */
  isUploading: boolean;
  /** True while one failed — the send must not go out. */
  hasFailedUpload: boolean;
}

/** What the bench needs beyond the composer's own props. */
type SessionComposerBenchProps = Omit<
  ComponentProps<typeof SessionComposer>,
  'waiting' | 'sessionId'
> & {
  /** The session being written to. */
  sessionId?: string;
  /** The staged files. Omitted means none, and no chip bar. */
  fileUpload?: BenchFileUpload;
  /**
   * The server-held queue, narrowed to what is genuinely waiting.
   *
   * Omitted means "read it the way `ChatPanel` does" — off the session
   * projection — which is what the suites that seed a queue through
   * `useSessionQueue` are relying on.
   */
  waiting?: QueuedMessage[];
};

/** No staged files, and nothing that can stage any. */
const NO_FILES: BenchFileUpload = {
  pendingFiles: [],
  onFilesSelected: () => {},
  onFileRemove: () => {},
  onFileRetry: () => {},
  onUploadCancel: () => {},
  isUploading: false,
  hasFailedUpload: false,
};

/**
 * Mount a session's composer inside the conversation it belongs to.
 *
 * @param props - The composer's own props, plus the staged files and queue the
 *   host would have resolved.
 */
export function SessionComposerBench({
  sessionId = 'test-session',
  fileUpload = NO_FILES,
  waiting,
  ...props
}: SessionComposerBenchProps) {
  const serverQueue = useSessionQueue(sessionId);
  const lifecycle = useSessionStreamLifecycle(sessionId);
  const read = useMemo(() => selectWaitingQueue(serverQueue, lifecycle), [serverQueue, lifecycle]);
  const held = waiting ?? read;
  const files = useMemo(
    () => ({
      pendingFiles: fileUpload.pendingFiles,
      addFiles: fileUpload.onFilesSelected,
      removeFile: fileUpload.onFileRemove,
      retryFile: fileUpload.onFileRetry,
      cancelUpload: fileUpload.onUploadCancel,
      hasFailedUpload: fileUpload.hasFailedUpload,
      isUploading: fileUpload.isUploading,
    }),
    [fileUpload]
  );
  const target = useSessionTarget({
    sessionId,
    // What the box says with no agent registered at the working directory,
    // which is what these suites render against.
    placeholder: 'Send a message...',
    submit: () => props.handleSubmit(),
    enqueue: props.enqueueContent,
    queueDepth: held.length,
    files,
  });
  return (
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES} target={target}>
      <SessionComposer {...props} sessionId={sessionId} waiting={held} />
    </Conversation.Root>
  );
}
