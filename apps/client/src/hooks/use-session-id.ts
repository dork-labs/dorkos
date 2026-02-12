import { getPlatform } from '../lib/platform';
import { useQueryState } from 'nuqs';
import { useAppStore } from '../stores/app-store';

export function useSessionId(): [string | null, (id: string | null) => void] {
  const platform = getPlatform();

  // In Obsidian: use Zustand store
  const storeId = useAppStore((s) => s.sessionId);
  const setStoreId = useAppStore((s) => s.setSessionId);

  // In standalone: use URL params
  const [urlId, setUrlId] = useQueryState('session');

  if (platform.isEmbedded) {
    return [storeId, setStoreId];
  }
  return [urlId, setUrlId];
}
