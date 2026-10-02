import type { SessionMessageAcceptanceReceipt } from '@dorkos/db';
import type { PrivateSessionMessageDispatchBinding } from './source-types.js';
import { PrivateSessionMessageRefusalError } from './refusal.js';
/** Runtime enforcement of synchronous protected-source callbacks. */
/** Refuse and observe thenables before committing source authority or starting a runtime. */
export function requireSynchronous<T>(result: T): T {
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Private message source callbacks must be synchronous.');
  }
  return result;
}

/** Match the actual runtime call to the durable protected destination before its exclusive claim. */
export function assertDispatchBinding(
  receipt: SessionMessageAcceptanceReceipt,
  binding?: PrivateSessionMessageDispatchBinding
): void {
  if (
    receipt.sourceKind === 'document_event_batch' &&
    binding &&
    (binding.sessionId !== receipt.sessionId || binding.runtime !== receipt.originRuntime)
  )
    throw new PrivateSessionMessageRefusalError(
      'dispatch_binding_changed',
      'This update is no longer available.'
    );
}
