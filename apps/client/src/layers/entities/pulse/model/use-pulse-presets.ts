import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { PulsePreset } from '@dorkos/shared/types';

export type { PulsePreset } from '@dorkos/shared/types';

/** Fetch available Pulse schedule presets from the server. */
export function usePulsePresets() {
  const transport = useTransport();
  return useQuery<PulsePreset[]>({
    queryKey: ['pulse', 'presets'],
    queryFn: () => transport.getPulsePresets(),
  });
}
