/**
 * "Keep these as mine" with its toast (DOR-2341).
 *
 * Wraps `useKeepPackageFiles` and says what happened in the server's own
 * sentence. A refusal (the files changed since they were shown, or the caller
 * is not the person) is an error toast with the server's reason, and nothing
 * was changed.
 *
 * @module features/marketplace/model/use-keep-files-with-toast
 */
import { useCallback } from 'react';
import { toast } from 'sonner';

import { useKeepPackageFiles, type KeepPackageFilesArgs } from '@/layers/entities/marketplace';

/**
 * `useKeepPackageFiles` with its toast. Mutation state passes through
 * unchanged, so a row can show its own busy state.
 */
export function useKeepFilesWithToast() {
  const keepFiles = useKeepPackageFiles();
  const { mutate: baseMutate } = keepFiles;

  const mutate = useCallback(
    (args: KeepPackageFilesArgs) => {
      baseMutate(args, {
        onSuccess: (result) => {
          toast.success(result.message);
        },
        onError: (err) => {
          toast.error(err.message);
        },
      });
    },
    [baseMutate]
  );

  return { ...keepFiles, mutate };
}
