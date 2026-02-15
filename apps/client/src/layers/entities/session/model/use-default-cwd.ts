import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/lib';
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
  });

  useEffect(() => {
    if (data?.path && selectedCwd === null) {
      setSelectedCwd(data.path);
    }
  }, [data, selectedCwd, setSelectedCwd]);
}
