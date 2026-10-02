/** Ratified private bounds; these are ceilings, not measured production capacity. */
export const BROKER_LIMITS = Object.freeze({
  listeners: 8,
  principals: 64,
  permits: 64,
  browserCircuits: 32,
  globalCircuits: 64,
  unauthenticated: 64,
  headerBytes: 16384,
  headerFields: 100,
  credentialBytes: 512,
  headBytes: 65536,
  queueBytes: 131072,
  bodyBytes: 67108864,
  duplexBytes: 536870912,
  leaseMs: 1800000,
  renewalLeadMs: 300000,
  permitMs: 5000,
  headerMs: 5000,
  authorityMs: 2000,
  dialMs: 5000,
  operationMs: 120000,
  idleMs: 120000,
  cleanupMs: 2000,
});
export type BrokerLimits = typeof BROKER_LIMITS;
/** Tests may lower bounds, never increase ratified ceilings or supply nonfinite values. */
export function brokerLimits(
  overrides: Partial<Record<keyof BrokerLimits, number>> = {}
): Readonly<Record<keyof BrokerLimits, number>> {
  const result = { ...BROKER_LIMITS };
  for (const key of Object.keys(overrides) as (keyof BrokerLimits)[]) {
    const value = overrides[key];
    if (!Number.isSafeInteger(value) || value! <= 0 || value! > BROKER_LIMITS[key])
      throw new Error('INVALID_BROKER_LIMIT');
    result[key] = value! as never;
  }
  return Object.freeze(result);
}
