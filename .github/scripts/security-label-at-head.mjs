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
 * force push on the PR's timeline, void a label placed before them. `after` adds
 * more times the head must be later than; any unreadable one refuses.
 */
function lastPush(sha, ref, timeline, activity, after) {
  const pushes = activity
    .filter((entry) => entry.after === sha && entry.ref === `refs/heads/${ref}`)
    .map((entry) => entry.timestamp);
  if (!pushes.length) return NaN;
  const forced = timeline
    .filter((event) => event.event === 'head_ref_force_pushed')
    .map((event) => event.created_at);
  // Math.max returns NaN on any unreadable time, which refuses below.
  return Math.max(...times(pushes), ...times(forced), ...times(after));
}

/**
 * The time GitHub first saw `sha` run anything: its oldest check suite. A
 * backdated committer date can't predate this. `undefined` when there is none,
 * which refuses as an unreadable time.
 *
 * @param {{created_at: string}[]} suites `GET /commits/{sha}/check-suites`.
 */
export function firstCheckSuite(suites) {
  if (!suites.length) return undefined;
  return suites
    .map((suite) => suite.created_at)
    .reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}

/**
 * Whether label `name` was last added by a person, after every push of `sha`.
 * Returns `{ passed, reason }`. Every missing or unreadable input refuses.
 *
 * @param {object} input
 * @param {string} input.name The label.
 * @param {string} input.sha The exact PR head being checked.
 * @param {string} input.ref The PR's head branch name.
 * @param {{name: string}[]} input.labels The PR's current labels.
 * @param {object[]} input.timeline `GET /issues/{n}/timeline`.
 * @param {object[]} input.activity `GET /activity?ref={ref}`.
 * @param {(string|undefined)[]} [input.after] More times the label must be later
 *   than, such as the committer date and {@link firstCheckSuite}.
 */
export function labelNewerThanHead({ name, sha, ref, labels, timeline, activity, after = [] }) {
  if (!labels.some((label) => label.name === name))
    return { passed: false, reason: `no ${name} label` };
  const added = timeline.filter((event) => event.event === 'labeled' && event.label?.name === name);
  if (!added.length) return { passed: false, reason: `no ${name} event` };
  const labelled = Math.max(...times(added.map((event) => event.created_at)));
  // Only the newest event counts: a candidate's own workflow holds a token that can
  // label its PR, so a bot must not revive a label a person removed.
  const newest = added.filter((event) => Date.parse(event.created_at) === labelled);
  if (newest.some((event) => event.actor?.type !== 'User'))
    return { passed: false, reason: `the newest ${name} event is not from a person` };
  const pushed = lastPush(sha, ref, timeline, activity, after);
  if (Number.isNaN(labelled) || Number.isNaN(pushed))
    return { passed: false, reason: `cannot read the push time of ${sha}` };
  if (labelled <= pushed)
    return {
      passed: false,
      reason: `${name} is older than the last push; remove it and add it again`,
    };
  return { passed: true, reason: `${name} is newer than the last push` };
}

/**
 * The gate's check: `security-reviewed`, newer than the head, with no `hold`.
 *
 * @param {object} input See {@link labelNewerThanHead}, less `name` and `after`.
 */
export function labelAtHead({ sha, ref, labels, timeline, activity }) {
  if (labels.some((label) => label.name === HOLD_LABEL))
    return { passed: false, reason: `the ${HOLD_LABEL} label is on` };
  return labelNewerThanHead({ name: REVIEW_LABEL, sha, ref, labels, timeline, activity });
}
