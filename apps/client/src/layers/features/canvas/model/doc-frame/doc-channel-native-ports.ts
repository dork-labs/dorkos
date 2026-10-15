/** Nonissuing request mechanics. Only recovery supplies these closed operations. */
import {
  PageEventSchema,
  CanvasChannelEventReceiptSchema,
  type PageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import type { WidgetChannelPort } from '@/layers/features/gen-ui';
type Original = NonNullable<ReturnType<NonNullable<WidgetChannelPort['captureOriginal']>>>;
interface ClosedOperations {
  current(purpose: 'read' | 'submit'): boolean;
  submit(event: PageEvent, signal: AbortSignal): ReturnType<WidgetChannelPort['submit']>;
  inspect(id: string, signal: AbortSignal): ReturnType<WidgetChannelPort['inspect']>;
  capture(event: PageEvent, bytes: string): Omit<ClosedOperations, 'capture'> | null;
}
/** Contains no issuer, birth, Transport, floor, registration API or frame binding. */
export function createDocChannelNativePorts(operations: ClosedOperations) {
  const unavailable = () =>
    Object.assign(new Error('Document actions are unavailable.'), { status: 409 });
  const requireCurrent = (purpose: 'read' | 'submit', signal: AbortSignal) => {
    if (signal.aborted || !operations.current(purpose)) throw unavailable();
    if (signal.aborted) throw unavailable();
  };
  const checked = (id: string, value: unknown) => {
    const receipt = CanvasChannelEventReceiptSchema.parse(value);
    if (receipt.receipt.id !== id) throw new Error('Document receipt does not match this action.');
    return receipt;
  };
  return Object.freeze({
    current: operations.current,
    submit: async (event: PageEvent, signal: AbortSignal) => {
      const input = PageEventSchema.parse(JSON.parse(JSON.stringify(event)));
      const originalId = input.id;
      requireCurrent('submit', signal);
      const value = await operations.submit(input, signal);
      requireCurrent('read', signal);
      const result = checked(originalId, value);
      requireCurrent('read', signal);
      return result;
    },
    inspect: async (id: string, signal: AbortSignal) => {
      requireCurrent('read', signal);
      const value = await operations.inspect(id, signal);
      requireCurrent('read', signal);
      const result = checked(id, value);
      requireCurrent('read', signal);
      return result;
    },
    captureOriginal: (event: PageEvent): Original | null => {
      const input = PageEventSchema.parse(JSON.parse(JSON.stringify(event)));
      const originalId = input.id;
      const bytes = JSON.stringify(input);
      if (!operations.current('submit')) return null;
      const captured = operations.capture(input, bytes);
      if (!captured || !operations.current('submit') || !captured.current('submit')) return null;
      let attempted = false;
      const originalCurrent = (purpose: 'read' | 'submit') => captured.current(purpose) === true;
      return Object.freeze({
        id: originalId,
        bytes,
        current: originalCurrent,
        submit: async (signal: AbortSignal) => {
          if (attempted || signal.aborted || !originalCurrent('submit')) throw unavailable();
          attempted = true; // Original operation cannot be recreated by retrying this handle.
          // Callback input is detached from the immutable original correlation and bytes.
          const value = await captured.submit(JSON.parse(bytes) as PageEvent, signal);
          if (signal.aborted || !originalCurrent('read')) throw unavailable();
          const result = checked(originalId, value);
          if (signal.aborted || !originalCurrent('read')) throw unavailable();
          return result;
        },
        inspect: async (signal: AbortSignal) => {
          if (signal.aborted || !originalCurrent('read')) throw unavailable();
          const value = await captured.inspect(originalId, signal);
          if (signal.aborted || !originalCurrent('read')) throw unavailable();
          const result = checked(originalId, value);
          if (signal.aborted || !originalCurrent('read')) throw unavailable();
          return result;
        },
      });
    },
  });
}

/** Map a closed original operation; this does not issue a frame or native owner. */
export function boundDocOriginal(original: Original) {
  return Object.freeze({
    id: original.id,
    bytes: original.bytes,
    submit: async (signal: AbortSignal) => {
      try {
        return { kind: 'accepted' as const, receipt: await original.submit(signal) };
      } catch {
        return { kind: 'uncertain' as const };
      }
    },
    inspect: async (signal: AbortSignal) => {
      try {
        return { kind: 'accepted' as const, receipt: await original.inspect(signal) };
      } catch {
        return { kind: 'unknown' as const };
      }
    },
  });
}

/** Wire parsing around an already closed capture callback; no issuer facts are accepted. */
export function captureBoundOriginal(
  request: { id: string; bytes: string },
  capture: (event: PageEvent) => Original | null,
  current: () => boolean
) {
  const event = PageEventSchema.parse(JSON.parse(request.bytes));
  if (event.id !== request.id || JSON.stringify(event) !== request.bytes || !current()) return null;
  const original = capture(event);
  if (!current() || !original) return null;
  return boundDocOriginal(original);
}
