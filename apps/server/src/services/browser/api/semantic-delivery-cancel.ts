const originals = new WeakMap<AbortSignal, object>();
/** Exact constructor-private request lifetime; no JSON caller can issue this receiver. */
export function ownSemanticDeliveryAbort(
  controller: AbortController
): Readonly<{ cancel(): void; reason: object }> {
  const reason = new Error('SEMANTIC_DELIVERY_CLOSED');
  const abort = controller.abort.bind(controller),
    signal = controller.signal;
  originals.set(signal, reason);
  return Object.freeze({ reason, cancel: () => abort(reason) });
}
/** Only this entered request's own actual abort qualifies cancellation. */
export function isOriginalSemanticDeliveryAbort(signal: AbortSignal, value: unknown): boolean {
  return signal.aborted && originals.get(signal) === value && Object.is(signal.reason, value);
}

/** Preserve the exact original request cancellation when reserving its owned stream birth. */
export function inheritSemanticDeliveryAbort(source: AbortSignal, target: AbortController): void {
  const reason = originals.get(source);
  if (reason) originals.set(target.signal, reason);
}
