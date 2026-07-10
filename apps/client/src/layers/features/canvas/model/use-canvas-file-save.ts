import { useCallback, useRef, useState } from 'react';
import { useTransport } from '@/layers/shared/model';

/** Lifecycle of a file-backed canvas save. */
export type CanvasSaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

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
export function useCanvasFileSave({ sourcePath, cwd, loadedContent }: UseCanvasFileSaveArgs) {
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

  const canSave = Boolean(sourcePath && cwd);

  const writeThrough = useCallback(
    async (
      fullContent: string,
      expected: { expectedHash?: string; expectedContent?: string }
    ): Promise<CanvasSaveStatus> => {
      const result = await transport.writeFile(
        cwd as string,
        sourcePath as string,
        fullContent,
        expected
      );
      if (result.ok) {
        baseHashRef.current = result.hash;
        baseContentRef.current = fullContent;
        setConflict(null);
        setStatus('saved');
        return 'saved';
      }
      setConflict(result.conflict);
      setStatus('conflict');
      return 'conflict';
    },
    [transport, cwd, sourcePath]
  );

  /**
   * Save the current document, conditional on the tracked disk base. Resolves
   * with the settled outcome — `'saved'` (including a no-op save), `'conflict'`,
   * `'error'`, or `'idle'` when the file isn't savable — so a caller flushing
   * before it renders (e.g. leaving edit mode) can react to the result without
   * reading the (asynchronously-updated) status state.
   */
  const save = useCallback(
    (fullContent: string): Promise<CanvasSaveStatus> => {
      if (!canSave) return Promise.resolve('idle');
      const next = inFlightRef.current
        .catch(() => {})
        .then(async (): Promise<CanvasSaveStatus> => {
          // Re-checked after the prior write settled, so the base is current.
          if (fullContent === baseContentRef.current) {
            setStatus('saved');
            return 'saved';
          }
          setStatus('saving');
          try {
            const expected =
              baseHashRef.current !== null
                ? { expectedHash: baseHashRef.current }
                : { expectedContent: baseContentRef.current };
            return await writeThrough(fullContent, expected);
          } catch {
            setStatus('error');
            return 'error';
          }
        });
      // The serialization chain stays void; the outcome rides the returned promise.
      inFlightRef.current = next.then(() => {});
      return next;
    },
    [canSave, writeThrough]
  );

  /** Reconcile a conflict by overwriting disk with the local draft. */
  const overwrite = useCallback(
    (fullContent: string): Promise<void> => {
      if (!conflict) return Promise.resolve();
      const expectedHash = conflict.currentHash;
      const next = inFlightRef.current
        .catch(() => {})
        .then(async () => {
          setStatus('saving');
          try {
            await writeThrough(fullContent, { expectedHash });
          } catch {
            setStatus('error');
          }
        });
      inFlightRef.current = next;
      return next;
    },
    [conflict, writeThrough]
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
    if (!conflict) return null;
    const adopted = conflict.currentContent;
    baseHashRef.current = conflict.currentHash;
    baseContentRef.current = adopted;
    setConflict(null);
    setStatus('idle');
    return adopted;
  }, [conflict]);

  return { status, conflict, canSave, save, overwrite, adoptDisk, getConfirmedBase };
}
