/**
 * Prepare-with-toast for a package an older DorkOS installed (DOR-2320).
 *
 * Wraps `useCheckPackageFiles` and says what happened in one toast: a loading
 * toast while the server fetches the version the package was installed from,
 * then the server's own sentence. A package that could not be prepared
 * (changed files, no network, installed from a local folder) is a warning, not
 * an error: nothing broke, and the sentence says what to do.
 *
 * @module features/marketplace/model/use-check-files-with-toast
 */
import { useCallback } from 'react';
import { toast } from 'sonner';

import { humanizePackageName } from '@/layers/shared/lib';
import { useCheckPackageFiles, type CheckPackageFilesArgs } from '@/layers/entities/marketplace';

/** {@link CheckPackageFilesArgs} plus a display-only place label ("Alpha") for the toast. */
export type CheckFilesWithToastArgs = CheckPackageFilesArgs & { where?: string };

/**
 * `useCheckPackageFiles` with its toast. Mutation state passes through unchanged,
 * so a row can show its own busy state.
 */
export function useCheckFilesWithToast() {
  const prepare = useCheckPackageFiles();
  const { mutate: baseMutate } = prepare;

  const mutate = useCallback(
    ({ where, ...args }: CheckFilesWithToastArgs) => {
      const subject = where
        ? `${humanizePackageName(args.name)} on ${where}`
        : humanizePackageName(args.name);
      const toastId = toast.loading(`Preparing ${subject}…`);
      baseMutate(args, {
        onSuccess: (result) => {
          const done = result.outcome === 'rebuilt' || result.outcome === 'not-needed';
          (done ? toast.success : toast.warning)(result.message, { id: toastId });
        },
        onError: (err) => {
          toast.error(`Couldn't prepare ${subject}: ${err.message}`, { id: toastId });
        },
      });
    },
    [baseMutate]
  );

  return { ...prepare, mutate };
}
