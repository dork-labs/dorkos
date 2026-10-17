/** Private host composition boundary; a page cannot choose routing or a replacement generation. */
import {
  CanvasChannelEventReceiptSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { parseCanvasDocWire } from '@dorkos/shared/canvas-doc-frame-wire';
import type { FrameDocBinding, FrameLifetimeController } from './frame-lifetime';
/** Original generation supplied separately from public PageEvent bytes on submit AND inspect. */
export interface DocTransportPrecondition {
  readonly expectedGeneration: string;
}
/** Exact original envelope; scope/document selection belongs exclusively to host composition. */
export interface BoundDocRequest {
  readonly id: string;
  readonly bytes: string;
}
/** A backend receipt proves acceptance; retry and uncertainty do not. */
export type DocSubmitResult =
  | { kind: 'accepted'; receipt: CanvasChannelEventReceipt }
  | { kind: 'retry'; retryAfterMs: number }
  | { kind: 'terminal' }
  | { kind: 'uncertain' };
/** Absence permits same-byte resend; lost/unknown retention never does. */
export type DocInspectResult =
  | { kind: 'accepted'; receipt: CanvasChannelEventReceipt }
  | { kind: 'absent' }
  | { kind: 'unknown' }
  | { kind: 'terminal' };
/** Mandatory explicit owner and current-authority transport ports, supplied only by the host. */
export interface DocTransportPorts {
  owner: object;
  publisherEpoch: number;
  isCurrentOwner(owner: object, epoch: number): boolean;
  submit(
    request: BoundDocRequest,
    condition: DocTransportPrecondition,
    signal: AbortSignal
  ): Promise<DocSubmitResult>;
  inspect(
    id: string,
    condition: DocTransportPrecondition,
    signal: AbortSignal
  ): Promise<DocInspectResult>;
}
/** Bound host-only API, never mounted by this helper module. */
export interface BoundDocPort {
  readonly binding: FrameDocBinding;
  current(): boolean;
  /** Verified page retirement can invalidate, never establish, the shared host lifetime. */
  retireObservation(): void;
  onRetire(callback: () => unknown): () => void;
  submit(request: BoundDocRequest, signal: AbortSignal): Promise<DocSubmitResult>;
  inspect(id: string, signal: AbortSignal): Promise<DocInspectResult>;
}
/** Require established birth/current captured transport before constructing any upstream port. */
export function createBoundDocPort(
  controller: FrameLifetimeController,
  binding: FrameDocBinding,
  ports: DocTransportPorts
): BoundDocPort {
  if (
    !ports ||
    typeof ports.submit !== 'function' ||
    typeof ports.inspect !== 'function' ||
    typeof ports.isCurrentOwner !== 'function' ||
    ports.owner !== binding.observation.transportOwner ||
    ports.publisherEpoch !== binding.observation.publisherEpoch
  )
    throw new Error('Explicit current transport submit and inspect ports required.');
  const { owner, publisherEpoch, isCurrentOwner, submit, inspect } = ports;
  const condition = Object.freeze({ expectedGeneration: binding.incarnation.generation });
  const current = () => {
    try {
      if (!controller.isCurrent(binding)) return false;
      const authorized = isCurrentOwner(owner, publisherEpoch) === true;
      return authorized && controller.isCurrent(binding);
    } catch {
      return false;
    }
  };
  if (!current()) throw new Error('Doc binding unavailable.');
  const requireCurrent = () => {
    if (!current()) throw new Error('Doc binding retired.');
  };
  return Object.freeze({
    binding,
    current,
    retireObservation: () => {
      if (current()) controller.retire();
    },
    onRetire: (callback: () => unknown) => controller.ownDoc(binding, callback),
    submit: (request: BoundDocRequest, signal: AbortSignal) => {
      requireCurrent();
      signal.throwIfAborted();
      return submit(request, condition, signal);
    },
    inspect: (id: string, signal: AbortSignal) => {
      requireCurrent();
      signal.throwIfAborted();
      return inspect(id, condition, signal);
    },
  });
}
/** Validate the original ID against a durable nonzero acceptance, never a replacement receipt. */
export function checkedDocReceipt(id: string, value: unknown): CanvasChannelEventReceipt | null {
  const parsed = parseCanvasDocWire(CanvasChannelEventReceiptSchema, value);
  return parsed && parsed.receipt.id === id && parsed.receipt.docSeq > 0 ? parsed : null;
}
