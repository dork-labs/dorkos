import type {
  DocSaveRefusalReason,
  FileSaveDiscovery,
  FileSaveRecoverResult,
} from '@dorkos/shared/file-save/recovery';
/**
 * One recovery call's outcome. `refused` is the server saying this document's
 * file cannot be saved here at all (404), with which check refused when the
 * server says (DOR-4442); `unavailable` is a fault worth retrying.
 */
export type RecoveryCall<T> =
  | { status: 'observed'; value: T }
  | { status: 'refused'; reason?: DocSaveRefusalReason }
  | { status: 'idle' | 'unavailable' | 'local_uncertain' };
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
