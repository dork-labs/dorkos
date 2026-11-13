/** The main-branch ruleset whose required checks date Security labels. */
export const REQUIRED_RULESET_NAME = 'main: merge queue';

/** Required checks that re-run on a label event, so they cannot date that label. */
export const LABEL_RERUN_CONTEXTS = [
  'security-gate',
  'fragment-present',
  'no-fragment-under-skip-label',
];

const PASSED_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Find the last passing required result at one exact head. Every missing,
 * unfinished, failed or unreadable result refuses.
 */
export function lastRequiredCheck({ contexts, checkRuns, statuses, sha }) {
  if (!Array.isArray(contexts) || !contexts.length)
    return { passed: false, reason: 'required check list is empty' };
  if (!Array.isArray(checkRuns) || !Array.isArray(statuses))
    return { passed: false, reason: `cannot read required checks at ${sha}` };

  const required = contexts.filter((context) => !LABEL_RERUN_CONTEXTS.includes(context));
  if (!required.length)
    return { passed: false, reason: 'no required checks remain after label re-runs' };

  const finished = [];
  for (const context of required) {
    const results = [
      ...checkRuns
        .filter((run) => run?.name === context)
        .map((run) => ({
          kind: 'check',
          value: run,
          at: run.status === 'completed' ? run.completed_at : run.started_at,
        })),
      ...statuses
        .filter((status) => status?.context === context)
        .map((status) => ({ kind: 'status', value: status, at: status.created_at })),
    ];
    if (!results.length)
      return { passed: false, reason: `${context} has not reported at ${sha}`, name: context };
    if (results.some((result) => Number.isNaN(Date.parse(result.at))))
      return {
        passed: false,
        reason: `cannot read when ${context} reported at ${sha}`,
        name: context,
      };

    const newest = results.reduce((latest, result) =>
      Date.parse(result.at) > Date.parse(latest.at) ? result : latest
    );
    if (
      (newest.kind === 'check' && newest.value.status !== 'completed') ||
      (newest.kind === 'status' && newest.value.state === 'pending')
    )
      return { passed: false, reason: `${context} has not finished at ${sha}`, name: context };
    if (
      (newest.kind === 'check' && !PASSED_CHECK_CONCLUSIONS.has(newest.value.conclusion)) ||
      (newest.kind === 'status' && newest.value.state !== 'success')
    )
      return { passed: false, reason: `${context} did not pass at ${sha}`, name: context };
    finished.push({ at: newest.at, name: context });
  }

  const latest = finished.reduce((last, result) =>
    Date.parse(result.at) > Date.parse(last.at) ? result : last
  );
  return { passed: true, reason: 'required checks passed', ...latest };
}
