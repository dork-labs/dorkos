import { useEffect } from 'react';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useQueryState } from 'nuqs';
import { useSessionId } from './use-session-id';

export function useDirectoryState(): [string | null, (dir: string | null) => void] {
  const platform = getPlatform();

  // Zustand state (used in embedded mode + sync target)
  const storeDir = useAppStore((s) => s.selectedCwd);
  const setStoreDir = useAppStore((s) => s.setSelectedCwd);

  // URL state (standalone mode)
  const [urlDir, setUrlDir] = useQueryState('dir');

  // Session clearing on directory change
  const [, setSessionId] = useSessionId();

  // Sync URL -> Zustand on initial load (standalone only)
  useEffect(() => {
    if (!platform.isEmbedded && urlDir && urlDir !== storeDir) {
      setStoreDir(urlDir);
    }
  }, [urlDir]); // Only re-run when URL changes (browser back/forward)

  if (platform.isEmbedded) {
    return [storeDir, (dir) => {
      if (dir) {
        setStoreDir(dir);
        setSessionId(null); // Clear session on dir change
      }
    }];
  }

  // Standalone: URL is source of truth, sync to Zustand
  return [
    urlDir ?? storeDir, // Fall back to Zustand (for default cwd set by useDefaultCwd)
    (dir) => {
      if (dir) {
        setUrlDir(dir);
        setStoreDir(dir);  // Sync to Zustand for localStorage + consumers
        setSessionId(null); // Clear session on dir change
      } else {
        setUrlDir(null);    // Remove from URL
      }
    },
  ];
}
