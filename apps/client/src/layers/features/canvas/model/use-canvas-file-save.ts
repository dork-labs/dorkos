import type { FileSaveDiscovery } from '@dorkos/shared/file-save/recovery';
import type { FileSaveRecoveryActions, RecoveryCall } from './file-save/recovery-ui-types';
import { createFileSaveRecoveryActions } from './file-save/recovery-actions';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import type { WriteFileResult } from '@dorkos/shared/transport';
import type { FileDocumentSaveReceipt } from '@dorkos/shared/schemas';
import {
  FileReceiptOperation,
  RetiredFileSaveError,
  type FileSaveBinding,
} from './file-save/receipt-operation';

/** Lifecycle of a file-backed canvas save. */
export type CanvasSaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict' | 'uncertain';

/** The server-acknowledged result of one conditional file save. */
export type CanvasSaveOutcome =
  | { status: 'changed' | 'no_op'; confirmed: { hash: string; content: string } }
  | { status: 'conflict' | 'error' | 'idle' | 'uncertain' };

/** The on-disk version surfaced when a save conflicts with an external change. */
export interface CanvasSaveConflict {
  currentHash: string;
  currentContent: string;
}

interface UseCanvasFileSaveArgs {
  /** Canvas incarnation; changing it retires outstanding work even for the same file. */
  documentId?: string;
  /** Captured when this operator session edit begins; absent keeps plain file saves. */
  documentSaveBinding?: FileSaveBinding;
  /** Existing genuine channel observation; no second replay owner. */
  documentRecoveryBinding?: FileSaveBinding;
  /** File path backing the canvas, or undefined for generated (read-only) content. */
  sourcePath: string | undefined;
  /** Session working directory the path is resolved within and confined to. */
  cwd: string | null;
  /** The full document as first loaded — the optimistic-concurrency base. */
  loadedContent: string;
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
  documentSaveBinding,
  documentRecoveryBinding,
}: UseCanvasFileSaveArgs) {
  const transport = useTransport();
  const birth = documentSaveBinding?.incarnation ?? documentRecoveryBinding?.incarnation;
  const birthKey = birth
    ? JSON.stringify([
        birth.documentId,
        birth.physicalOpenedAt,
        birth.channelCreatedAt,
        birth.generation,
      ])
    : undefined;
  const receiptLane = useRef(new FileReceiptOperation());
  // Rendering a candidate identity has no effect on the committed owner.
  const owner = useMemo(
    () => ({ sourcePath, cwd, documentId, transport, birthKey }),
    [sourcePath, cwd, documentId, transport, birthKey]
  );
  // Uncertainty belongs to its exact dispatch owner, not merely a matching birth.
  const pendingReceiptOwner = useRef<typeof owner | null>(null);
  const ownerRef = useRef<{
    identity: typeof owner;
    baseHash: string | null;
    baseContent: string;
    active: boolean;
    recoveryBinding?: FileSaveBinding;
    recoveryGate: 'unsupported' | 'pending' | 'observed_clear' | 'blocked' | 'unavailable';
    discovery?: Promise<RecoveryCall<FileSaveDiscovery>>;
    recoveryBusy?: boolean;
    finalToken?: { content: string; id: symbol };
  } | null>(null);
  // Keep one dispatch tail across owners: a new incarnation cannot race a
  // previously dispatched write against the server's conditional file write.
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());
  const currentOwner = useCallback(
    () => ownerRef.current?.identity === owner && ownerRef.current.active,
    [owner]
  );
  useLayoutEffect(() => {
    if (ownerRef.current?.identity !== owner) {
      ownerRef.current = {
        identity: owner,
        baseHash: null,
        baseContent: loadedContent,
        active: true,
        recoveryBinding: documentRecoveryBinding,
        recoveryGate:
          documentRecoveryBinding && transport.originalFileSaveRecovery ? 'pending' : 'unsupported',
      };
    } else {
      ownerRef.current.active = true;
      ownerRef.current.recoveryBinding = documentRecoveryBinding;
    }
    return () => {
      if (ownerRef.current?.identity === owner) ownerRef.current.active = false;
    };
  }, [owner, loadedContent, documentRecoveryBinding, transport]);
  const [state, setState] = useState<{
    owner: typeof owner;
    status: CanvasSaveStatus;
    conflict: CanvasSaveConflict | null;
    documentReceipt?: FileDocumentSaveReceipt;
    confirmedContent?: string;
  }>({ owner, status: 'idle', conflict: null });
  const status = state.owner === owner ? state.status : 'idle';
  const conflict = state.owner === owner ? state.conflict : null;
  const setStatus = useCallback(
    (
      next: CanvasSaveStatus,
      documentReceipt?: FileDocumentSaveReceipt,
      confirmedContent?: string
    ) => {
      if (currentOwner())
        setState((previous) => ({
          owner,
          status: next,
          documentReceipt,
          confirmedContent,
          conflict: previous.owner === owner ? previous.conflict : null,
        }));
    },
    [owner, currentOwner]
  );
  const setConflict = useCallback(
    (next: CanvasSaveConflict | null) => {
      if (currentOwner())
        setState((previous) => ({
          owner,
          conflict: next,
          status: previous.owner === owner ? previous.status : 'idle',
        }));
    },
    [owner, currentOwner]
  );

  const recoveryWritable = useCallback(
    () =>
      ownerRef.current?.recoveryGate === 'unsupported' ||
      ownerRef.current?.recoveryGate === 'observed_clear',
    []
  );
  const recoveryActions = useMemo<FileSaveRecoveryActions>(() => {
    // Construct the private factory only when an effect or event invokes an action.
    const deferredActions = () =>
      createFileSaveRecoveryActions({
        owner,
        getOwner: () => ownerRef.current,
        readTail: () => inFlightRef.current,
        writeTail: (tail) => {
          inFlightRef.current = tail;
        },
        transport,
        cwd,
        sourcePath,
        documentId,
        pending: () => receiptLane.current.pending,
      });
    return {
      identity: owner,
      supported: !!transport.originalFileSaveRecovery,
      current: () => deferredActions().current(),
      discover: (fresh) => deferredActions().discover(fresh),
      recover: (eventId) => deferredActions().recover(eventId),
      inspectCurrent: () => deferredActions().inspectCurrent(),
    };
  }, [owner, transport, cwd, sourcePath, documentId]);

  const canSave = Boolean(sourcePath && cwd);

  const acknowledge = useCallback(
    (
      record: NonNullable<typeof ownerRef.current>,
      result: WriteFileResult,
      fullContent: string,
      finalDrain = false
    ): CanvasSaveOutcome => {
      const visible = () =>
        currentOwner() &&
        ownerRef.current === record &&
        (!documentSaveBinding || documentSaveBinding.current());
      if (result.ok) {
        if (
          typeof result.hash !== 'string' ||
          !result.hash ||
          (result.effect !== 'changed' && result.effect !== 'no_op')
        )
          throw new Error('Invalid file save acknowledgement');
        record.baseHash = result.hash;
        record.baseContent = fullContent;
        if (!finalDrain && !visible()) return { status: 'idle' };
        if (!finalDrain) {
          setConflict(null);
          setStatus('saved', receiptLane.current.receipt, fullContent);
        }
        return { status: result.effect, confirmed: { hash: result.hash, content: fullContent } };
      }
      if (!finalDrain && !visible()) return { status: 'idle' };
      if (!finalDrain) {
        setConflict(result.conflict);
        setStatus('conflict');
      }
      return { status: 'conflict' };
    },
    [currentOwner, documentSaveBinding, setConflict, setStatus]
  );

  const writeThrough = useCallback(
    async (
      fullContent: string,
      expected: { expectedHash?: string; expectedContent?: string }
    ): Promise<CanvasSaveOutcome> => {
      if (!currentOwner()) return { status: 'idle' };
      const record = ownerRef.current!;
      if (documentSaveBinding && !receiptLane.current.pending) pendingReceiptOwner.current = owner;
      const result = await receiptLane.current.write(
        transport,
        cwd as string,
        sourcePath as string,
        fullContent,
        expected,
        documentSaveBinding
      );
      return acknowledge(record, result, fullContent);
    },
    [currentOwner, transport, cwd, sourcePath, documentSaveBinding, acknowledge, owner]
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
      const admittedFinalToken =
        ownerRef.current!.finalToken?.content === fullContent
          ? ownerRef.current!.finalToken
          : undefined;
      const next = inFlightRef.current
        .catch(() => {})
        .then(async (): Promise<CanvasSaveOutcome> => {
          if (!currentOwner() || (documentSaveBinding && !documentSaveBinding.current()))
            return { status: 'idle' };
          if (receiptLane.current.pending) {
            setStatus('uncertain');
            return { status: 'uncertain' };
          }
          if (!recoveryWritable()) {
            setStatus('error');
            return { status: 'error' };
          }
          if (ownerRef.current!.finalToken === admittedFinalToken)
            ownerRef.current!.finalToken = undefined;
          setStatus('saving');
          try {
            const expected =
              ownerRef.current!.baseHash !== null
                ? { expectedHash: ownerRef.current!.baseHash }
                : { expectedContent: ownerRef.current!.baseContent };
            return await writeThrough(fullContent, expected);
          } catch (error) {
            if (error instanceof RetiredFileSaveError) return { status: 'idle' };
            if (!currentOwner() || (documentSaveBinding && !documentSaveBinding.current()))
              return { status: 'idle' };
            const status = receiptLane.current.pending ? 'uncertain' : 'error';
            setStatus(status);
            return { status };
          }
        });
      // The serialization chain stays void; the outcome rides the returned promise.
      inFlightRef.current = next.then(() => {});
      return next;
    },
    [canSave, writeThrough, currentOwner, setStatus, documentSaveBinding, recoveryWritable]
  );

  /** Prepare the latest buffered draft for one explicit passive-unmount drain.
   * Ordinary callbacks remain retired. This handle cannot cross an owner change,
   * replace a newer draft, or dispatch twice; it shares the normal save queue.
   */
  const prepareFinalSave = useCallback(
    (fullContent: string) => {
      if (!canSave || !currentOwner() || (documentSaveBinding && !documentSaveBinding.current()))
        return null;
      const record = ownerRef.current!;
      const token = { content: fullContent, id: Symbol('buffered canvas draft') };
      record.finalToken = token;
      return {
        cancel() {
          if (record.finalToken === token) record.finalToken = undefined;
        },
        flush(): Promise<CanvasSaveOutcome> {
          if (record.finalToken !== token || ownerRef.current !== record || record.active)
            return Promise.resolve({ status: 'idle' });
          record.finalToken = undefined;
          const next = inFlightRef.current
            .catch(() => {})
            .then(async (): Promise<CanvasSaveOutcome> => {
              if (ownerRef.current !== record || record.active) return { status: 'idle' };
              try {
                if (
                  record.recoveryGate !== 'unsupported' &&
                  record.recoveryGate !== 'observed_clear'
                )
                  return { status: 'error' };
                const expected =
                  record.baseHash !== null
                    ? { expectedHash: record.baseHash }
                    : { expectedContent: record.baseContent };
                if (documentSaveBinding && !receiptLane.current.pending)
                  pendingReceiptOwner.current = owner;
                const result = await receiptLane.current.write(
                  transport,
                  cwd as string,
                  sourcePath as string,
                  fullContent,
                  expected,
                  documentSaveBinding,
                  true
                );
                return acknowledge(record, result, fullContent, true);
              } catch {
                return { status: 'error' };
              }
            });
          inFlightRef.current = next.then(() => {});
          return next;
        },
      };
    },
    [canSave, currentOwner, transport, cwd, sourcePath, documentSaveBinding, acknowledge, owner]
  );

  /** Observe only an already-admitted passive drain; never dispatch under a retired owner. */
  const waitForCloseDrain = useCallback(
    async (content: string): Promise<boolean> => {
      const record = ownerRef.current;
      if (!record || record.identity !== owner) return false;
      await inFlightRef.current.catch(() => {});
      return (
        ownerRef.current === record &&
        !receiptLane.current.pending &&
        record.baseContent === content
      );
    },
    [owner]
  );

  /** Recover the exact original operation; newer drafts never replace its uncertain identity. */
  const retryUnconfirmed = useCallback((): Promise<CanvasSaveOutcome> => {
    if (!currentOwner() || !documentSaveBinding || pendingReceiptOwner.current !== owner)
      return Promise.resolve({ status: 'idle' });
    const record = ownerRef.current!;
    const next = inFlightRef.current
      .catch(() => {})
      .then(async (): Promise<CanvasSaveOutcome> => {
        if (!currentOwner() || ownerRef.current !== record || pendingReceiptOwner.current !== owner)
          return { status: 'idle' };
        try {
          setStatus('saving');
          const recovered = await receiptLane.current.retry(transport, documentSaveBinding);
          return acknowledge(record, recovered.result, recovered.content);
        } catch (error) {
          if (
            error instanceof RetiredFileSaveError ||
            !currentOwner() ||
            ownerRef.current !== record
          )
            return { status: 'idle' };
          const status = receiptLane.current.pending ? 'uncertain' : 'error';
          setStatus(status);
          return { status };
        }
      });
    inFlightRef.current = next.then(() => {});
    return next;
  }, [currentOwner, documentSaveBinding, transport, acknowledge, setStatus, owner]);

  /** Reconcile a conflict by overwriting disk with the local draft. */
  const overwrite = useCallback(
    (fullContent: string): Promise<CanvasSaveOutcome> => {
      if (!canSave || !conflict || !currentOwner()) return Promise.resolve({ status: 'idle' });
      const expectedHash = conflict.currentHash;
      const admittedFinalToken =
        ownerRef.current!.finalToken?.content === fullContent
          ? ownerRef.current!.finalToken
          : undefined;
      const next = inFlightRef.current
        .catch(() => {})
        .then(async (): Promise<CanvasSaveOutcome> => {
          if (!currentOwner() || (documentSaveBinding && !documentSaveBinding.current()))
            return { status: 'idle' };
          if (receiptLane.current.pending) {
            setStatus('uncertain');
            return { status: 'uncertain' };
          }
          if (!recoveryWritable()) {
            setStatus('error');
            return { status: 'error' };
          }
          if (ownerRef.current!.finalToken === admittedFinalToken)
            ownerRef.current!.finalToken = undefined;
          setStatus('saving');
          try {
            return await writeThrough(fullContent, { expectedHash });
          } catch (error) {
            if (error instanceof RetiredFileSaveError) return { status: 'idle' };
            if (!currentOwner() || (documentSaveBinding && !documentSaveBinding.current()))
              return { status: 'idle' };
            const status = receiptLane.current.pending ? 'uncertain' : 'error';
            setStatus(status);
            return { status };
          }
        });
      inFlightRef.current = next.then(() => {});
      return next;
    },
    [
      canSave,
      conflict,
      writeThrough,
      currentOwner,
      setStatus,
      documentSaveBinding,
      recoveryWritable,
    ]
  );

  /**
   * Snapshot the confirmed on-disk base — the content and hash of the last write
   * this hook is certain landed. Lets a caller reflect just-saved bytes into its
   * own read cache without a refetch. `hash` is null until the first confirmed
   * write; `content` equals the last saved (or the initially-loaded) document.
   */
  const getConfirmedBase = useCallback(
    (): { hash: string | null; content: string } =>
      ownerRef.current?.identity === owner
        ? { hash: ownerRef.current.baseHash, content: ownerRef.current.baseContent }
        : { hash: null, content: loadedContent },
    [owner, loadedContent]
  );

  /** Reconcile a conflict by adopting the on-disk version as the new base. */
  const adoptDisk = useCallback(() => {
    if (!conflict || !currentOwner() || (documentSaveBinding && !documentSaveBinding.current()))
      return null;
    ownerRef.current!.finalToken = undefined;
    const adopted = conflict.currentContent;
    ownerRef.current!.baseHash = conflict.currentHash;
    ownerRef.current!.baseContent = adopted;
    setConflict(null);
    setStatus('idle');
    return adopted;
  }, [conflict, currentOwner, setConflict, setStatus, documentSaveBinding]);

  return {
    recovery: recoveryActions,
    status,
    conflict,
    canSave,
    save,
    overwrite,
    adoptDisk,
    getConfirmedBase,
    prepareFinalSave,
    retryUnconfirmed,
    waitForCloseDrain,
    documentReceipt: state.owner === owner ? state.documentReceipt : undefined,
    confirmedContent: state.owner === owner ? state.confirmedContent : undefined,
  };
}
