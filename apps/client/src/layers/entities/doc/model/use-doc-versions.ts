/**
 * A doc's saved versions, and putting one back (DOR-2984; the DOR-2983
 * "Restore previous version" decision).
 *
 * @module entities/doc/model/use-doc-versions
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocRef, DocVersion } from '@dorkos/shared/doc-collab';
import { useTransport } from '@/layers/shared/model';

/** The cache key of one doc's saved versions. */
export function docVersionsKey(doc: DocRef) {
  return ['doc-versions', doc.cwd, doc.path] as const;
}

/**
 * A doc's saved versions, newest first. Reads nothing while `doc` is `null`.
 *
 * @param doc - The doc, or `null` when Docs are off or there is no doc.
 */
export function useDocVersions(doc: DocRef | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: doc ? docVersionsKey(doc) : ['doc-versions', 'none'],
    queryFn: async (): Promise<DocVersion[]> => (await transport.listDocVersions(doc!)).versions,
    enabled: doc !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Put a doc's saved version back. Refreshes its version list after.
 *
 * @param doc - The doc.
 */
export function useRestoreDocVersion(doc: DocRef) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => transport.restoreDocVersion(doc, versionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: docVersionsKey(doc) }),
  });
}
