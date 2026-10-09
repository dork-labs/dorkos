import type { BrowserBinding } from '@dorkos/browser';
import type {
  OwnedUploadLease,
  OwnedDownloadSink,
  OwnedDownloadArtifact,
} from '@dorkos/browser/server-owner';
import type { VMRecord } from './record.mjs';
interface OriginalTransfer {
  begin(signal: AbortSignal): Promise<void>;
  complete(binding: BrowserBinding, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export function createOriginalVMUpload(
  record: VMRecord,
  lease: OwnedUploadLease,
  current: () => boolean
): OriginalTransfer;
export function createOriginalVMDownload(
  record: VMRecord,
  sink: OwnedDownloadSink,
  current: () => boolean
): OriginalTransfer & Readonly<{ artifact(): OwnedDownloadArtifact }>;
export function inspectOriginalVMTransfer(
  owner: unknown,
  record: VMRecord
): Readonly<{ record: VMRecord }>;
