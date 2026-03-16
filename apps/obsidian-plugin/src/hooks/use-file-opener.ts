import { useCallback } from 'react';
import { getPlatform } from '@dorkos/client/lib/platform';

/** Provide a callback to open a file via the platform adapter. */
export function useFileOpener() {
  const openFile = useCallback(async (path: string) => {
    await getPlatform().openFile(path);
  }, []);
  return { openFile };
}
