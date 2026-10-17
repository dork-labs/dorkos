/**
 * The docs in one space, read through the Transport (DOR-2982).
 *
 * @module entities/doc/model/use-doc-index
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocIndex } from '@dorkos/shared/doc-links';
import { useTransport } from '@/layers/shared/model';
import { docKeys } from '../api/query-keys';

/**
 * Every doc reached from a working directory: path, title and slug.
 *
 * Idle while `enabled` is false or there is no working directory, so nothing
 * asks the server while the Docs experiment is off. Docs change outside
 * DorkOS with no event to say so (an agent writes a file, a person edits one
 * elsewhere), so this one query reads again when the window comes back.
 * Structural sharing keeps the data's identity while a read answers the same
 * docs, which is what lets a wiki-link resolver built from it stay cached.
 *
 * @param cwd - The working directory, or `null` when there is none.
 * @param enabled - Whether to read at all; the Docs experiment's state.
 */
export function useDocIndex(cwd: string | null, enabled: boolean) {
  const transport = useTransport();
  return useQuery<DocIndex>({
    queryKey: docKeys.index(cwd ?? ''),
    queryFn: () => transport.getDocIndex(cwd as string),
    enabled: enabled && cwd !== null,
    refetchOnWindowFocus: true,
  });
}

/**
 * A function that marks the doc index of one working directory stale and
 * reads it again if it is shown, e.g. after a doc is created, renamed or
 * saved. With no working directory, every doc index.
 */
export function useInvalidateDocIndex(): (cwd?: string | null) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (cwd?: string | null) => {
      void queryClient.invalidateQueries({ queryKey: cwd ? docKeys.index(cwd) : docKeys.all });
    },
    [queryClient]
  );
}
