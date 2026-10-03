/** Count validated channel observations only; omitted reports leave lower bounds, never zeros of certainty. */
export function guardianObservations(guardians) {
  const counts = {
    runnerSubjects: 1,
    guardianSubjects: 0,
    fixtureSubjects: 0,
    identityQueries: 0,
    censusCalls: 0,
    exitRegistrations: 0,
    exitEvents: 0,
    signals: 0,
    deliveries: 0,
    refusals: 0,
    terminations: 0,
    cleanupSignals: 0,
  };
  let countsComplete = true;
  for (const guardian of guardians) {
    counts.guardianSubjects += Number(guardian.spawnObserved === true);
    for (const event of guardian.events) {
      counts.signals++;
      counts.deliveries += Number(event.type === 'attempt' && event.delivery === true);
      counts.refusals += Number(event.type === 'attempt' && event.refusal === true);
      counts.terminations += Number(event.type === 'termination' && event.observed === true);
    }
    if (guardian.validated !== true || guardian.failure) {
      countsComplete = false;
      continue;
    }
    if (
      guardian.result.status !== 'observed' &&
      guardian.result.reason !== 'NATIVE_EXPORT_UNAVAILABLE'
    )
      countsComplete = false;
    for (const key of [
      'fixtureSubjects',
      'identityQueries',
      'censusCalls',
      'exitRegistrations',
      'exitEvents',
    ])
      counts[key] += guardian.result[key];
  }
  return {
    counts,
    countsComplete,
    countBasis:
      'validated guardian reports and received attempt records; lower bounds if incomplete',
  };
}
