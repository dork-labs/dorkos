/**
 * Label-at-head: decides whether a `security-reviewed` label still covers a PR's
 * head while no Security App is configured. No imports and no I/O: the caller
 * passes in what GitHub returned. dork-labs/marketplace shares this file; change
 * it here and re-pin it there, never fork it.
 */

export const REVIEW_LABEL = 'security-reviewed';
export const HOLD_LABEL = 'hold';

/** The workflow's placeholder. Anything else, even garbage, stays in App mode and refuses. */
export function approvalMode(botUserId) {
  return String(botUserId) === '0' ? 'label-at-head' : 'app';
}

function times(values) {
  return values.map((value) => Date.parse(value));
}

/**
 * GitHub has no synchronize event to read back, so a head's push time is its
 * newest entry in the repository activity feed. A head can only come back to an
 * old SHA through a force push, so the feed's newest entry for that SHA, and any
 * force push on the PR's timeline, void a label placed before them.
 */
function lastPush(sha, ref, timeline, activity) {
  const pushes = activity
    .filter((entry) => entry.after === sha && entry.ref === `refs/heads/${ref}`)
    .map((entry) => entry.timestamp);
  if (!pushes.length) return NaN;
  const forced = timeline
    .filter((event) => event.event === 'head_ref_force_pushed')
    .map((event) => event.created_at);
  // Math.max returns NaN on any unreadable time, which refuses below.
  return Math.max(...times(pushes), ...times(forced));
}

/**
 * Returns `{ passed, reason }`. Every missing or unreadable input refuses.
 *
 * @param {object} input
 * @param {string} input.sha The exact PR head being checked.
 * @param {string} input.ref The PR's head branch name.
 * @param {{name: string}[]} input.labels The PR's current labels.
 * @param {object[]} input.timeline `GET /issues/{n}/timeline`.
 * @param {object[]} input.activity `GET /activity?ref={ref}`.
 */
export function labelAtHead({ sha, ref, labels, timeline, activity }) {
  const names = labels.map((label) => label.name);
  if (names.includes(HOLD_LABEL)) return { passed: false, reason: `the ${HOLD_LABEL} label is on` };
  if (!names.includes(REVIEW_LABEL)) return { passed: false, reason: `no ${REVIEW_LABEL} label` };
  const added = timeline.filter(
    (event) => event.event === 'labeled' && event.label?.name === REVIEW_LABEL
  );
  if (!added.length) return { passed: false, reason: `no ${REVIEW_LABEL} event` };
  const labelled = Math.max(...times(added.map((event) => event.created_at)));
  // Only the newest event counts: a candidate's own workflow holds a token that can
  // label its PR, so a bot must not revive a label a person removed.
  const newest = added.filter((event) => Date.parse(event.created_at) === labelled);
  if (newest.some((event) => event.actor?.type !== 'User'))
    return { passed: false, reason: `the newest ${REVIEW_LABEL} event is not from a person` };
  const pushed = lastPush(sha, ref, timeline, activity);
  if (Number.isNaN(labelled) || Number.isNaN(pushed))
    return { passed: false, reason: `cannot read the push time of ${sha}` };
  if (labelled <= pushed)
    return {
      passed: false,
      reason: `${REVIEW_LABEL} is older than the last push; remove it and add it again`,
    };
  return { passed: true, reason: `${REVIEW_LABEL} is newer than the last push` };
}
