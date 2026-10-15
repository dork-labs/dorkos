import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTransport } from '@/layers/shared/model';

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
  /** Canvas incarnation; changing it retires outstanding work even for the same file. */
  documentId?: string;
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
}: UseCanvasFileSaveArgs) {
  const transport = useTransport();
  // Rendering a candidate identity has no effect on the committed owner.
  const owner = useMemo(
    () => ({ sourcePath, cwd, documentId, transport }),
    [sourcePath, cwd, documentId, transport]
  );
  const ownerRef = useRef<{
    identity: typeof owner;
    baseHash: string | null;
    baseContent: string;
    active: boolean;
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
      };
    } else {
      ownerRef.current.active = true;
    }
    return () => {
      if (ownerRef.current?.identity === owner) ownerRef.current.active = false;
    };
  }, [owner, loadedContent]);
  const [state, setState] = useState<{
    owner: typeof owner;
    status: CanvasSaveStatus;
    conflict: CanvasSaveConflict | null;
  }>({ owner, status: 'idle', conflict: null });
  const status = state.owner === owner ? state.status : 'idle';
  const conflict = state.owner === owner ? state.conflict : null;
  const setStatus = useCallback(
    (next: CanvasSaveStatus) => {
      if (currentOwner())
        setState((previous) => ({
          owner,
          status: next,
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

  const canSave = Boolean(sourcePath && cwd);

  const writeThrough = useCallback(
    async (
      fullContent: string,
      expected: { expectedHash?: string; expectedContent?: string }
    ): Promise<CanvasSaveOutcome> => {
      if (!currentOwner()) return { status: 'idle' };
      const result = await transport.writeFile(
        cwd as string,
        sourcePath as string,
        fullContent,
        expected
      );
      if (!currentOwner()) return { status: 'idle' };
      if (result.ok) {
        if (
          typeof result.hash !== 'string' ||
          result.hash.length === 0 ||
          (result.effect !== 'changed' && result.effect !== 'no_op')
        ) {
          throw new Error('Invalid file save acknowledgement');
        }
        ownerRef.current!.baseHash = result.hash;
        ownerRef.current!.baseContent = fullContent;
        setConflict(null);
        setStatus('saved');
        return { status: result.effect, confirmed: { hash: result.hash, content: fullContent } };
      }
      setConflict(result.conflict);
      setStatus('conflict');
      return { status: 'conflict' };
    },
    [transport, cwd, sourcePath, currentOwner, setConflict, setStatus]
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
      const next = inFlightRef.current
        .catch(() => {})
        .then(async (): Promise<CanvasSaveOutcome> => {
          if (!currentOwner()) return { status: 'idle' };
          setStatus('saving');
          try {
            const expected =
              ownerRef.current!.baseHash !== null
                ? { expectedHash: ownerRef.current!.baseHash }
                : { expectedContent: ownerRef.current!.baseContent };
            return await writeThrough(fullContent, expected);
          } catch {
            if (!currentOwner()) return { status: 'idle' };
            setStatus('error');
            return { status: 'error' };
          }
        });
      // The serialization chain stays void; the outcome rides the returned promise.
      inFlightRef.current = next.then(() => {});
      return next;
    },
    [canSave, writeThrough, currentOwner, setStatus]
  );

  /** Reconcile a conflict by overwriting disk with the local draft. */
  const overwrite = useCallback(
    (fullContent: string): Promise<CanvasSaveOutcome> => {
      if (!canSave || !conflict || !currentOwner()) return Promise.resolve({ status: 'idle' });
      const expectedHash = conflict.currentHash;
      const next = inFlightRef.current
        .catch(() => {})
        .then(async (): Promise<CanvasSaveOutcome> => {
          if (!currentOwner()) return { status: 'idle' };
          setStatus('saving');
          try {
            return await writeThrough(fullContent, { expectedHash });
          } catch {
            if (!currentOwner()) return { status: 'idle' };
            setStatus('error');
            return { status: 'error' };
          }
        });
      inFlightRef.current = next.then(() => {});
      return next;
    },
    [canSave, conflict, writeThrough, currentOwner, setStatus]
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
    if (!conflict || !currentOwner()) return null;
    const adopted = conflict.currentContent;
    ownerRef.current!.baseHash = conflict.currentHash;
    ownerRef.current!.baseContent = adopted;
    setConflict(null);
    setStatus('idle');
    return adopted;
  }, [conflict, currentOwner, setConflict, setStatus]);

  return { status, conflict, canSave, save, overwrite, adoptDisk, getConfirmedBase };
}
