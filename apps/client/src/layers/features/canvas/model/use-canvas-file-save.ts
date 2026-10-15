import { useCallback, useEffect, useRef, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import {
  CanvasDocumentSaveIdentitySchema,
  type CanvasDocumentSaveIdentity,
} from '@dorkos/shared/schemas';
import {
  CanvasChannelManagementSnapshotSchema,
  CanvasChannelEventReceiptSchema,
} from '@dorkos/shared/canvas-channel-schemas';
interface OriginalDocumentSaveOperation {
  readonly content: string;
  readonly expected: Readonly<{
    expectedHash?: string;
    expectedContent?: string;
    documentSave: Readonly<CanvasDocumentSaveIdentity>;
  }>;
  uncertain: boolean;
}

/** Lifecycle of a file-backed canvas save. */
export type CanvasSaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

/** The server-acknowledged result of one conditional file save. */
export type CanvasSaveOutcome =
  | { status: 'changed' | 'no_op'; confirmed: { hash: string; content: string } }
  | { status: 'conflict' | 'error' | 'idle' };

/** The on-disk version surfaced when a save conflicts with an external change. */
export interface CanvasSaveConflict {
  currentHash: string;
  currentContent: string;
}

interface UseCanvasFileSaveArgs {
  /** File path backing the canvas, or undefined for generated (read-only) content. */
  sourcePath: string | undefined;
  /** Session working directory the path is resolved within and confined to. */
  cwd: string | null;
  /** The full document as first loaded — the optimistic-concurrency base. */
  loadedContent: string;
  /** Genuine canvas identity; generic file callers omit it. */
  documentId?: string;
  /** Original loaded raw-byte hash, usable only with the untouched loaded content. */
  initialHash?: string;
}

/**
 * Save a file-backed markdown canvas back to disk: save status, optimistic-
 * concurrency base, and conflict reconciliation. This hook owns the transport
 * write and the disk-version bookkeeping; the editor component owns the document
 * text and decides what to pass in.
 *
 * All content hashing is done server-side: the first save sends the baseline
 * *content* (the server hashes it), and every confirmed write returns the new
 * hash, which conditions the next save. The client never needs `crypto.subtle`
 * (absent on insecure origins). Writes are serialized through an in-flight chain
 * so two overlapping saves cannot race the base bookkeeping into a spurious
 * conflict. A write whose base no longer matches disk resolves to a conflict the
 * caller can reconcile by adopting the disk version or overwriting it.
 */
export function useCanvasFileSave({
  sourcePath,
  cwd,
  loadedContent,
  documentId,
  initialHash,
}: UseCanvasFileSaveArgs) {
  const transport = useTransport();
  const [status, setStatus] = useState<CanvasSaveStatus>('idle');
  const [conflict, setConflict] = useState<CanvasSaveConflict | null>(null);

  // The hash and bytes the next write expects on disk. `baseHash` is null until
  // the first confirmed write returns one; until then writes are conditioned on
  // `baseContent` (server-hashed). Advanced only by confirmed writes — never
  // reset by an incoming `loadedContent` change, so an unrelated display update
  // can at worst trigger a (recoverable) conflict rather than a silent clobber.
  const baseHashRef = useRef<string | null>(null);
  const baseContentRef = useRef(loadedContent);
  // Serializes writes so two overlapping saves can't race the base bookkeeping.
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());

  const pendingWritesRef = useRef(0);
  const documentOwner = useRef({
    documentId,
    sourcePath,
    cwd,
    transport,
    initialContent: loadedContent,
    initialHash,
    retired: false,
    operation: null as OriginalDocumentSaveOperation | null,
  });
  if (
    (documentId || documentOwner.current.documentId) &&
    (documentOwner.current.documentId !== documentId ||
      documentOwner.current.sourcePath !== sourcePath ||
      documentOwner.current.cwd !== cwd ||
      documentOwner.current.transport !== transport)
  ) {
    documentOwner.current.retired = true;
    documentOwner.current = {
      documentId,
      sourcePath,
      cwd,
      transport,
      initialContent: loadedContent,
      initialHash,
      retired: false,
      operation: null,
    };
    baseHashRef.current = null;
    baseContentRef.current = loadedContent;
    inFlightRef.current = Promise.resolve();
    pendingWritesRef.current = 0;
    setStatus('idle');
    setConflict(null);
  }
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = documentOwner.current;
  const currentOwner = useCallback(
    () =>
      documentId === undefined
        ? documentOwner.current.documentId === undefined
        : !owner.retired && documentOwner.current === owner,
    [documentId, owner]
  );
  const publishCurrent = useCallback(
    () => currentOwner() && (!documentId || mounted.current),
    [documentId, currentOwner]
  );
  const canSave = Boolean(sourcePath && cwd);

  const writeThrough = useCallback(
    async (
      fullContent: string,
      expected: { expectedHash?: string; expectedContent?: string }
    ): Promise<CanvasSaveOutcome> => {
      if (!currentOwner()) return { status: 'idle' };
      let operation = documentId ? owner.operation : null;
      if (operation && operation.content !== fullContent)
        throw new Error(
          'Review or retry the original unconfirmed save before saving another draft.'
        );
      if (documentId && !operation) {
        const baseContent = baseContentRef.current,
          baseHash = baseHashRef.current;
        const expectedFileHash =
          expected.expectedHash ??
          (baseContent === owner.initialContent ? owner.initialHash : undefined);
        if (!expectedFileHash)
          throw new Error('Reload the original file before saving this document.');
        // No ordinary write is started while original document generation capture is pending.
        const metadata = CanvasChannelManagementSnapshotSchema.parse(
          await transport.getCanvasDocManagement(documentId)
        );
        if (
          !currentOwner() ||
          metadata.documentId !== documentId ||
          baseContentRef.current !== baseContent ||
          baseHashRef.current !== baseHash
        )
          throw new Error('The document changed while its save was being prepared.');
        const identity = Object.freeze(
          CanvasDocumentSaveIdentitySchema.parse({
            documentId,
            expectedGeneration: metadata.generation,
            eventId: crypto.randomUUID(),
            expectedFileHash,
          })
        );
        operation = {
          content: fullContent,
          expected: Object.freeze({ ...expected, documentSave: identity }),
          uncertain: false,
        };
        owner.operation = operation;
      }
      let result: Awaited<ReturnType<typeof transport.writeFile>>;
      try {
        result = await transport.writeFile(
          cwd as string,
          sourcePath as string,
          operation?.content ?? fullContent,
          operation?.expected ?? expected
        );
        if (
          result.ok &&
          (typeof result.hash !== 'string' ||
            result.hash.length === 0 ||
            (documentId && !/^[a-f0-9]{64}$/.test(result.hash)) ||
            (result.effect !== 'changed' && result.effect !== 'no_op'))
        )
          throw new Error('Invalid file save acknowledgement');
        if (
          !result.ok &&
          operation &&
          (typeof result.conflict.currentHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(result.conflict.currentHash) ||
            typeof result.conflict.currentContent !== 'string')
        )
          throw new Error('Invalid file save conflict');
        if (result.ok && operation) {
          if (result.effect === 'changed' && !result.documentReceipt)
            throw new Error(
              'The native document save receipt is missing. Retry the original save.'
            );
          if (result.documentReceipt) {
            const receipt = CanvasChannelEventReceiptSchema.parse(result.documentReceipt);
            if (
              receipt.receipt.id !== operation.expected.documentSave.eventId ||
              receipt.receipt.status !== (result.effect === 'changed' ? 'recorded' : 'duplicate')
            )
              throw new Error(
                'The native document save receipt differs from the original operation.'
              );
          }
        }
      } catch (cause) {
        if (operation) operation.uncertain = true;
        throw cause;
      }
      if (!currentOwner()) return { status: 'idle' };
      if (result.ok) {
        baseHashRef.current = result.hash;
        baseContentRef.current = fullContent;
        if (operation) owner.operation = null;
        if (publishCurrent()) {
          setConflict(null);
          setStatus('saved');
        }
        return { status: result.effect, confirmed: { hash: result.hash, content: fullContent } };
      }
      if (operation && !operation.uncertain) owner.operation = null;
      if (publishCurrent()) {
        setConflict(result.conflict);
        setStatus('conflict');
      }
      return { status: 'conflict' };
    },
    [transport, cwd, sourcePath, documentId, owner, currentOwner, publishCurrent]
  );

  /**
   * Save the current document, conditional on the tracked disk base. Resolves
   * with the server's changed/no-op acknowledgement, a conflict/error, or idle
   * when the file isn't savable. Even identical local bytes go to the server,
   * so a caller flushing before it renders (e.g. leaving edit mode) can react
   * to the result without
   * reading the (asynchronously-updated) status state.
   */
  const save = useCallback(
    (fullContent: string): Promise<CanvasSaveOutcome> => {
      if (!canSave || !currentOwner()) return Promise.resolve({ status: 'idle' });
      pendingWritesRef.current++;
      const next = inFlightRef.current
        .catch(() => {})
        .then(async (): Promise<CanvasSaveOutcome> => {
          if (!currentOwner()) return { status: 'idle' };
          if (publishCurrent()) setStatus('saving');
          try {
            const expected =
              baseHashRef.current !== null
                ? { expectedHash: baseHashRef.current }
                : { expectedContent: baseContentRef.current };
            return await writeThrough(fullContent, expected);
          } catch {
            if (publishCurrent()) setStatus('error');
            return { status: 'error' };
          }
        });
      // The serialization chain stays void; the outcome rides the returned promise.
      inFlightRef.current = next
        .then(() => {})
        .finally(() => {
          if (currentOwner()) pendingWritesRef.current--;
        });
      return next;
    },
    [canSave, writeThrough, currentOwner, publishCurrent]
  );

  /** Reconcile a conflict by overwriting disk with the local draft. */
  const overwrite = useCallback(
    (fullContent: string): Promise<CanvasSaveOutcome> => {
      if (!canSave || !conflict || !currentOwner()) return Promise.resolve({ status: 'idle' });
      const expectedHash = conflict.currentHash;
      pendingWritesRef.current++;
      const next = inFlightRef.current
        .catch(() => {})
        .then(async (): Promise<CanvasSaveOutcome> => {
          if (!currentOwner()) return { status: 'idle' };
          if (publishCurrent()) setStatus('saving');
          try {
            return await writeThrough(fullContent, { expectedHash });
          } catch {
            if (publishCurrent()) setStatus('error');
            return { status: 'error' };
          }
        });
      inFlightRef.current = next
        .then(() => {})
        .finally(() => {
          if (currentOwner()) pendingWritesRef.current--;
        });
      return next;
    },
    [canSave, conflict, writeThrough, currentOwner, publishCurrent]
  );

  /**
   * Snapshot the confirmed on-disk base — the content and hash of the last write
   * this hook is certain landed. Lets a caller reflect just-saved bytes into its
   * own read cache without a refetch. `hash` is null until the first confirmed
   * write; `content` equals the last saved (or the initially-loaded) document.
   */
  const getConfirmedBase = useCallback(
    (): { hash: string | null; content: string } => ({
      hash: baseHashRef.current,
      content: baseContentRef.current,
    }),
    []
  );

  /** Reconcile a conflict by adopting the on-disk version as the new base. */
  const adoptDisk = useCallback(() => {
    if (!conflict || !currentOwner()) return null;
    const adopted = conflict.currentContent;
    // Actual explicit disk review retires an uncertain original operation, not an automatic retry.
    if (documentId) owner.operation = null;
    baseHashRef.current = conflict.currentHash;
    baseContentRef.current = adopted;
    setConflict(null);
    setStatus('idle');
    return adopted;
  }, [conflict, documentId, owner, currentOwner]);

  /** Advance the full-content save baseline only after a separately acknowledged native marker write. */
  const adoptConfirmedCheckbox = (before: string, confirmed: { content: string; hash: string }) => {
    if (
      !currentOwner() ||
      pendingWritesRef.current !== 0 ||
      owner.operation ||
      baseContentRef.current !== before
    )
      return false;
    baseContentRef.current = confirmed.content;
    baseHashRef.current = confirmed.hash;
    setConflict(null);
    setStatus('saved');
    return true;
  };
  const canWriteCheckbox = (before: string) =>
    currentOwner() &&
    pendingWritesRef.current === 0 &&
    !owner.operation &&
    baseContentRef.current === before;
  return {
    status,
    conflict,
    pendingDocumentSave: documentId !== undefined && owner.operation !== null,
    canRetryDocumentSave: pendingWritesRef.current === 0 && owner.operation !== null,
    retryOriginalSave: () =>
      currentOwner() && owner.operation && pendingWritesRef.current === 0
        ? save(owner.operation.content)
        : Promise.resolve<CanvasSaveOutcome>({ status: 'idle' }),
    canSave,
    save,
    overwrite,
    adoptDisk,
    getConfirmedBase,
    adoptConfirmedCheckbox,
    canWriteCheckbox,
  };
}
