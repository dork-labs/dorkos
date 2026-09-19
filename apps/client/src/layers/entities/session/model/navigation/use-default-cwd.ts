import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useEffect } from 'react';

/**
 * Fetches the server's default cwd on startup and sets it in the store.
 * Only runs once (when selectedCwd is null).
 */
export function useDefaultCwd() {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setSelectedCwd = useAppStore((s) => s.setSelectedCwd);

  const { data } = useQuery({
    queryKey: ['defaultCwd'],
    queryFn: () => transport.getDefaultCwd(),
    enabled: selectedCwd === null,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    // **Dropped wifi is not a reason to stop asking localhost.** TanStack's
    // default `networkMode: 'online'` PAUSES a fetch whenever
    // `navigator.onLine` is false, and this server is not on the internet —
    // the ruling `useConfig` states at length, applied here because the whole app
    // waits on this one and a paused read leaves the directory null forever,
    // which every session read is scoped by (DOR-2103).
    networkMode: 'always',
  });

  useEffect(() => {
    if (data?.path && selectedCwd === null) {
      setSelectedCwd(data.path);
    }
  }, [data, selectedCwd, setSelectedCwd]);
}
