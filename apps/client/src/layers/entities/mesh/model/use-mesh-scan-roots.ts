import { useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/**
 * Manage mesh scan roots — reads from server config with boundary fallback,
 * persists changes via PATCH /api/config.
 */
export function useMeshScanRoots() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const scanRoots = config?.mesh?.scanRoots ?? [];
  const boundary = config?.boundary ?? '';

  // Use configured scan roots if any, otherwise fall back to boundary
  const roots = scanRoots.length > 0 ? scanRoots : boundary ? [boundary] : [];

  const { mutate: saveScanRoots, isPending: isSaving } = useMutation({
    mutationFn: async (newRoots: string[]) => {
      await transport.updateConfig({ mesh: { scanRoots: newRoots } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });

  const setScanRoots = useCallback(
    (newRoots: string[]) => saveScanRoots(newRoots),
    [saveScanRoots]
  );

  return { roots, boundary, isSaving, setScanRoots };
}
