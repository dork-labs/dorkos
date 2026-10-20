/** Explicit optional original-save proof port; absence is unsupported, never empty history. */
import type { CanvasDocIncarnation } from '../canvas-channel-schemas.js';
import type { FileSaveDiscovery, FileSaveRecoverResult } from './recovery.js';
export interface OriginalFileSaveRecoveryPort {
  discover(documentId: string): Promise<FileSaveDiscovery>;
  recover(
    documentId: string,
    eventId: string,
    expectedIncarnation: CanvasDocIncarnation
  ): Promise<FileSaveRecoverResult>;
}
export interface FileSaveRecoveryTransport {
  readonly originalFileSaveRecovery?: OriginalFileSaveRecoveryPort;
}
