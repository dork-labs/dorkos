/**
 * Recognize only an explicit fixture's domain refusal; malformed inputs and wiring faults stay failures.
 * @internal Used by the conformance wrapper and its regression tests.
 */
export function isExpectedInvokeRefusal(
  capabilityId: string,
  error: unknown,
  fixtures: { expectedInvokeRefusal?: Record<string, (error: Error) => boolean> }
): boolean {
  if (
    !(error instanceof Error) ||
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error.name === 'ZodError'
  )
    return false;
  return fixtures.expectedInvokeRefusal?.[capabilityId]?.(error) === true;
}

/**
 * Whether a thrown value is the registry's gate refusal — the error
 * `registry.invoke` raises when the tier gate did not allow a call. Duck-typed by
 * name so this suite stays free of a `@dorkos/server` import.
 *
 * @param err - The thrown value.
 * @returns True when it is a `CapabilityGateRefusal`.
 */
export function isGateRefusal(err: unknown): err is { decision: { payload: unknown } } {
  return err instanceof Error && err.name === 'CapabilityGateRefusal';
}

/**
 * Whether a thrown value is the server's `CapabilityToolError` — the structured
 * domain-error a handler raises through the plain-data seam. Duck-typed by name
 * so this suite stays free of a `@dorkos/server` import.
 *
 * @param err - The thrown value.
 * @returns True when it is a `CapabilityToolError`.
 */
export function isCapabilityToolError(err: unknown): boolean {
  return err instanceof Error && err.name === 'CapabilityToolError';
}
