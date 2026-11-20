/**
 * Settings → Backups data (DOR-4253): the list of database copies, and a
 * person's Remove and Move on older ones. Both actions refresh the list.
 *
 * @module features/settings/model/use-backups
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** The one cache entry Settings → Backups reads. */
export const BACKUPS_QUERY_KEY = ['config', 'backups'] as const;

/** The backup list, read when the tab opens and after every action. */
export function useBackups() {
  const transport = useTransport();
  return useQuery({
    queryKey: BACKUPS_QUERY_KEY,
    queryFn: () => transport.listBackups(),
    // Localhost answers whatever the wifi is doing (see `useConfig`, DOR-2103).
    networkMode: 'always',
  });
}

/** Remove one older copy. */
export function useRemoveBackup() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => transport.removeBackup(name),
    networkMode: 'always',
    onSettled: () => queryClient.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY }),
  });
}

/** Move one older copy into a folder the person picked. */
export function useMoveBackup() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, destination }: { name: string; destination: string }) =>
      transport.moveBackup(name, destination),
    networkMode: 'always',
    onSettled: () => queryClient.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY }),
  });
}

/**
 * A byte count as a person reads it: `512 B`, `4.2 MB`, `1.3 GB`.
 *
 * @param bytes - A non-negative size in bytes.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}
