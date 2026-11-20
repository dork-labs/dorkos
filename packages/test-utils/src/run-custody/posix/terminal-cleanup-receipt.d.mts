/** Existing guardian terminal metadata only; no request, credential or control fields. */
export interface TerminalCleanupMetadata {
  kind: 'never-acquired' | 'cleaned-owned' | 'cleanup-uncertain';
  anchorClose?: { code: number | null; signal: string | null };
}
/** Validate an existing owned descriptor without creating any file. */
export function validateTerminalCleanupReceiptFd(fd: number): import('node:fs').BigIntStats;
/** One bounded observation attempt; absent descriptors perform no filesystem I/O. */
export function createTerminalCleanupReceipt(
  fd?: number
): (receipt: TerminalCleanupMetadata) => boolean;
