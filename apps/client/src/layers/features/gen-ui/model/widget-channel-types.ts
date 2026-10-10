/** Type-only public contract extracted from the original native widget owner. */
import type {
  PageEvent,
  CanvasChannelEventReceipt,
  CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
/** Closed original request. Inspection never creates another initial submission. */
export interface WidgetOriginalRequest {
  readonly id: string;
  readonly bytes: string;
  current(purpose: 'read' | 'submit'): boolean;
  submit(signal: AbortSignal): Promise<CanvasChannelEventReceipt>;
  inspect(signal: AbortSignal): Promise<CanvasChannelEventReceipt>;
}
/** Genuine native ports close over an issued physical owner. Gallery ports remain local fixtures. */
export interface WidgetChannelPort {
  documentId: string;
  enabled: boolean;
  destinationLabel: string;
  approvedEventTypes: readonly string[];
  submissionOwner?: object;
  current?(purpose: 'read' | 'submit'): boolean;
  snapshot?: Pick<
    CanvasChannelReplayResponse,
    'state' | 'stateRev' | 'receipts' | 'retentionFloor' | 'receiptRetentionFloor' | 'resetRequired'
  >;
  captureOriginal?(event: PageEvent): WidgetOriginalRequest | null;
  submit(event: PageEvent, signal: AbortSignal): Promise<CanvasChannelEventReceipt>;
  inspect(eventId: string, signal: AbortSignal): Promise<CanvasChannelEventReceipt>;
}

export interface WidgetChannelSubmission {
  controlId: string;
  documentId: string;
  normalized: boolean;
  event: PageEvent;
  phase: 'sending' | 'retry' | 'refused' | 'review' | 'accepted';
  receipt?: CanvasChannelEventReceipt;
  message?: string;
}
