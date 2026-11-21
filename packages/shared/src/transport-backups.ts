/**
 * The Transport slice for Settings → Backups (DOR-4253): the copies of this
 * computer's DorkOS database, and a person's Remove and Move on older ones.
 * Types only, so the app reads them with no build. The same shape is described
 * for the API docs in the server's `backups-openapi.ts`; change both together.
 *
 * @module shared/transport-backups
 */

/** What a backup copy was taken for. */
export type BackupCopyKind = 'daily' | 'pre-upgrade';

/** One backup copy, as Settings → Backups lists it. */
export interface BackupCopyInfo {
  /** The file name inside the backup folder; the id every action takes. */
  name: string;
  /** What the copy was taken for. */
  kind: BackupCopyKind;
  /** True when DorkOS keeps and prunes it on its own (`dork-auto-` copies). */
  managed: boolean;
  /** Size on disk, in bytes. */
  sizeBytes: number;
  /** When the copy was taken (ISO 8601, UTC). */
  createdAt: string;
  /** A write is in progress next to it, so it can't be removed or moved now. */
  busy: boolean;
}

/** Every copy in the backup folder and their total size. */
export interface BackupCopiesResponse {
  /** The backup folder's path, to show the person where the copies live. */
  folder: string;
  /** Newest first. */
  copies: BackupCopyInfo[];
  /** The sum of every listed copy's size, in bytes. */
  totalBytes: number;
}

/** Where a moved copy now lives. */
export interface BackupMoveResponse {
  /** The copy's new absolute path. */
  destinationPath: string;
}

/** What the app does with this computer's database backups. Person-only on the server. */
export interface BackupsTransport {
  /** List every backup copy in the backup folder. */
  listBackups(): Promise<BackupCopiesResponse>;
  /** Remove one older copy. DorkOS-managed copies are refused. */
  removeBackup(name: string): Promise<void>;
  /** Move one older copy into a folder the person chose, checked before the original goes. */
  moveBackup(name: string, destination: string): Promise<BackupMoveResponse>;
}
