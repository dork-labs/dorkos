import type { BrowserBinding, BrowserCommand } from '../contracts.js';
import type { NativeInputTransport, NativeInputStep, CleanupInputStep } from './types.js';

/** Private acceptance instrumentation; absent from every package export and wire schema.
 * It observes genuine queue admission and native acknowledgement. It cannot replace
 * an original transport, grant, command, policy, cleanup permit or acknowledgement. */
export interface OriginalInputAcceptanceObserver {
  matches(binding: BrowserBinding): boolean;
  admitted(requestId: string, binding: BrowserBinding): void;
  resetPublished(binding: BrowserBinding): void;
  afterNativeAcknowledgement(
    step: NativeInputStep | CleanupInputStep,
    binding: BrowserBinding,
    signal: AbortSignal
  ): Promise<void>;
  dispose(): void;
}
let installed: Readonly<{ observer: OriginalInputAcceptanceObserver }> | undefined;
let failure: Readonly<{ value: unknown }> | undefined;
/** Imported only by the in-process native fixture, never by public server-owner consumers. */
export function installOriginalInputAcceptanceObserver(observer: OriginalInputAcceptanceObserver) {
  if (installed) throw new Error('INPUT_ACCEPTANCE_OBSERVER_ALREADY_INSTALLED');
  const owner = Object.freeze({ observer });
  installed = owner;
  failure = undefined;
  return Object.freeze({
    assertHealthy() {
      if (failure) throw failure.value;
    },
    close() {
      if (installed !== owner) return;
      installed = undefined;
      observer.dispose();
    },
  });
}
function select(binding: BrowserBinding | null): OriginalInputAcceptanceObserver | undefined {
  const owner = installed;
  if (!binding || !owner) return;
  try {
    return owner.observer.matches(binding) ? owner.observer : undefined;
  } catch (value) {
    failure ??= { value };
  }
}
/** Notify the private observer after the original queue admits this exact command. */
export function observeOriginalQueueAdmission(command: Extract<BrowserCommand, { kind: 'input' }>) {
  try {
    select(command.binding)?.admitted(command.requestId, command.binding);
  } catch (value) {
    failure ??= { value };
  }
}
/** Observe the canonical binding published by the original reset barrier. */
export function observeOriginalReset(binding: BrowserBinding) {
  try {
    select(binding)?.resetPublished(binding);
  } catch (value) {
    failure ??= { value };
  }
}
/** Capture all original methods once. The callback runs only after the original
 * promise fulfilled; fixture cancellation never fabricates native settlement. */
export function observeOriginalNativeInput(
  native: NativeInputTransport,
  read: () => BrowserBinding | null
): NativeInputTransport {
  const dispatch = native.dispatch.bind(native),
    composition = native.cancelComposition.bind(native),
    drag = native.cancelDrag.bind(native),
    cleanup = native.cleanup.bind(native);
  const after = async (
    step: NativeInputStep | CleanupInputStep,
    binding: BrowserBinding | null,
    signal: AbortSignal
  ) => {
    const observer = select(binding);
    if (!observer || !binding) return;
    try {
      await observer.afterNativeAcknowledgement(step, binding, signal);
    } catch (value) {
      failure ??= { value };
      throw value;
    }
  };
  const safeRead = () => {
    try {
      return read();
    } catch (value) {
      failure ??= { value };
      return null;
    }
  };
  const observed: NativeInputTransport = {
    async dispatch(step, signal, current) {
      const binding = safeRead();
      await dispatch(step, signal, current);
      await after(step, binding, signal);
    },
    async cancelComposition(signal) {
      const binding = safeRead();
      await composition(signal);
      await after({ kind: 'cancelComposition' }, binding, signal);
    },
    async cancelDrag(signal) {
      const binding = safeRead();
      await drag(signal);
      await after({ kind: 'cancelDrag' }, binding, signal);
    },
    async cleanup(permit, attempt, signal) {
      const binding = safeRead();
      await cleanup(permit, attempt, signal);
      await after(attempt.step, binding, signal);
    },
  };
  return Object.freeze(observed);
}
