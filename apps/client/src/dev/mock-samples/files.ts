import type { PendingFile } from '@/layers/features/composer';
import { createPendingFile } from '../mock-factories';

/**
 * Pending-file rows — one per upload state: pending, uploading, uploaded,
 * error, and a second pending row.
 *
 * @module dev/mock-samples/files
 */
export const SAMPLE_FILES: PendingFile[] = [
  createPendingFile({
    file: new File(['hello'], 'readme.md', { type: 'text/markdown' }),
    status: 'pending',
    progress: 0,
  }),
  createPendingFile({
    file: new File(['data'], 'report.csv', { type: 'text/csv' }),
    status: 'uploading',
    progress: 45,
  }),
  createPendingFile({
    file: new File(['done'], 'config.json', { type: 'application/json' }),
    status: 'uploaded',
    progress: 100,
    result: {
      savedPath: '/uploads/config.json',
      originalName: 'config.json',
      filename: 'config.json',
      size: 4,
      mimeType: 'application/json',
    },
  }),
  createPendingFile({
    file: new File(['err'], 'huge.bin', { type: 'application/octet-stream' }),
    status: 'error',
    progress: 12,
    error: 'File too large (max 10 MB)',
  }),
  createPendingFile({
    file: new File(['img'], 'screenshot.png', { type: 'image/png' }),
    status: 'pending',
    progress: 0,
  }),
];

/** File-palette entries — a mix of files and one directory, with fuzzy-match indices. */
export const SAMPLE_FILE_ENTRIES: Array<
  import('@/layers/shared/lib').FileEntry & { indices: number[] }
> = [
  {
    path: 'src/services/auth/auth-handler.ts',
    filename: 'auth-handler.ts',
    directory: 'src/services/auth/',
    isDirectory: false,
    indices: [18, 19, 20, 21], // "auth" in filename
  },
  {
    path: 'src/services/auth/',
    filename: 'auth',
    directory: 'src/services/',
    isDirectory: true,
    indices: [0, 1, 2, 3],
  },
  {
    path: 'src/routes/api/sessions.ts',
    filename: 'sessions.ts',
    directory: 'src/routes/api/',
    isDirectory: false,
    indices: [0, 1, 2, 3, 4, 5, 6, 7], // "sessions" in filename
  },
  {
    path: 'src/lib/logger.ts',
    filename: 'logger.ts',
    directory: 'src/lib/',
    isDirectory: false,
    indices: [],
  },
  {
    path: 'packages/shared/src/types.ts',
    filename: 'types.ts',
    directory: 'packages/shared/src/',
    isDirectory: false,
    indices: [],
  },
  {
    path: 'AGENTS.md',
    filename: 'AGENTS.md',
    directory: '',
    isDirectory: false,
    indices: [],
  },
];
