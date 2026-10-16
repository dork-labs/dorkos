import type { FileSaveDiscovery, FileSaveRecoverResult } from '@dorkos/shared/file-save/recovery';
export type RecoveryCall<T> =
  { status: 'observed'; value: T } | { status: 'idle' | 'unavailable' | 'local_uncertain' };
export interface FileSaveRecoveryActions {
  readonly identity: object;
  readonly supported: boolean;
  current(): boolean;
  discover(fresh?: boolean): Promise<RecoveryCall<FileSaveDiscovery>>;
  recover(
    eventId: string
  ): Promise<RecoveryCall<{ result: FileSaveRecoverResult; discovery: FileSaveDiscovery }>>;
  inspectCurrent(): Promise<RecoveryCall<{ content: string; hash: string }>>;
}
