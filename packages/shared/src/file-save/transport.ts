/** Conditional file writes, with optional server-owned document receipt correlation. */
import type { FileDocumentSaveReceipt, FileDocumentSaveRequest } from './schemas.js';

/** Correlation does not grant document authority; the server rechecks the caller and birth. */
export interface WriteFileOptions {
  expectedHash?: string;
  expectedContent?: string;
  documentSave?: FileDocumentSaveRequest;
}
/** A file acknowledgement alone never implies that a document saved event exists. */
export type WriteFileResult =
  | {
      ok: true;
      hash: string;
      effect: 'changed' | 'no_op';
      documentReceipt?: FileDocumentSaveReceipt;
    }
  | { ok: false; conflict: { currentHash: string; currentContent: string } };
