/** An intended broken implementation was observed at its cause-specific measurement boundary. */
export class NegativeObservation extends Error {
  constructor(fault, sampleCount) {
    super(`Observed negative implementation: ${fault}`);
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1)
      throw TypeError('OBSERVED_SAMPLE_COUNT_REQUIRED');
    this.fault = fault;
    this.sampleCount = sampleCount;
  }
}

/** Classify only the intended observation; unrelated assertions cannot certify a control. */
export function classifyNegative(observation, fault) {
  const detected =
    observation.failure instanceof NegativeObservation && observation.failure.fault === fault;
  return {
    outcome: detected ? 'detected' : observation.status === 'pass' ? 'missed' : 'unverified',
    sampleCount: detected ? observation.failure.sampleCount : (observation.result?.samples ?? 0),
  };
}
