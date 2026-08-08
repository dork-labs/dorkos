import type { UploadResult } from '@dorkos/shared/types';

/**
 * A file pending upload with status and progress tracking.
 *
 * The composer owns this shape because it is what an attachment chip renders
 * (`ComposerAttachments`); the surface that actually performs the upload — chat's
 * `useFileUpload` today, rooms in DOR-947 — produces it.
 */
export interface PendingFile {
  /** Unique identifier for the pending file entry. */
  id: string;
  /** The browser File object selected by the user. */
  file: File;
  /** Current lifecycle state of this upload. */
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  /** Upload progress percentage (0–100). Batch-level, not per-file. */
  progress: number;
  /** Upload result from the server — available once status is 'uploaded'. */
  result?: UploadResult;
  /** Error message — available once status is 'error'. */
  error?: string;
}
