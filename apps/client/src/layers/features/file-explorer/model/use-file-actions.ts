import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import type { FileEntry } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { requestComposerInsert } from '@/layers/shared/lib';
import { useConfig } from '@/layers/entities/config';
import { toastCrudError } from '../lib/crud-errors';
import { revealActionLabel, toAbsolutePath } from '../lib/paths';

/**
 * The explorer's non-mutating row actions (DOR-1032): show an entry in the
 * operating system's file manager, copy its path, and hand it to the chat.
 *
 * None of these touch the tree, so they stay out of `use-file-crud` (which owns
 * the optimistic cache dance). Copy succeeds silently — the menu closing is the
 * acknowledgement — and only failures speak up, per the copy-path convention
 * every editor shares.
 *
 * @module features/file-explorer/model/use-file-actions
 */

/** Which spelling of a path the "copy" actions put on the clipboard. */
export type CopyPathKind = 'absolute' | 'relative';

/** The non-mutating action surface the explorer UI drives. */
export interface FileActionsApi {
  /**
   * Label for the reveal menu item, named after the server platform's own file
   * manager — or `null` when this transport cannot open one, in which case the
   * item is not offered at all.
   */
  revealLabel: string | null;
  /** Show an entry in the server machine's file manager. */
  reveal: (entry: FileEntry) => Promise<void>;
  /** Copy an entry's path to the system clipboard. */
  copyPath: (entry: FileEntry, kind: CopyPathKind) => Promise<void>;
  /** Insert `@<path>` into the chat composer and focus it. */
  addToChat: (entry: FileEntry) => void;
}

/**
 * Bind the explorer's reveal / copy-path / add-to-chat actions to a working
 * directory.
 *
 * @param cwd - Session working directory, or null when none is selected.
 */
export function useFileActions(cwd: string | null): FileActionsApi {
  const transport = useTransport();
  const { data: config } = useConfig();

  const revealLabel = useMemo(
    () => (transport.supportsReveal ? revealActionLabel(config?.platform) : null),
    [transport.supportsReveal, config?.platform]
  );

  const reveal = useCallback(
    async (entry: FileEntry): Promise<void> => {
      if (!cwd) return;
      try {
        await transport.revealEntry(cwd, entry.path);
      } catch (err) {
        toastCrudError(err, "Couldn't open the file manager");
      }
    },
    [transport, cwd]
  );

  const copyPath = useCallback(
    async (entry: FileEntry, kind: CopyPathKind): Promise<void> => {
      const text = kind === 'absolute' && cwd ? toAbsolutePath(cwd, entry.path) : entry.path;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard writes are denied outside a secure context or when the
        // browser withholds permission; there is nothing to retry, so say so
        // once rather than failing silently.
        toast.error("Couldn't copy to the clipboard");
      }
    },
    [cwd]
  );

  const addToChat = useCallback((entry: FileEntry): void => {
    // Trailing space so the next thing typed is a new word — the same shape the
    // composer's own `@` file picker inserts.
    const delivered = requestComposerInsert(`@${entry.path} `);
    if (!delivered) toast.error('Open a chat first to add a file to it');
  }, []);

  return { revealLabel, reveal, copyPath, addToChat };
}
