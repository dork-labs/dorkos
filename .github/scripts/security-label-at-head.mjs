/**
 * Label-at-head: decides whether a `security-reviewed` label still covers a PR's
 * head while no Security App is configured, and that Security put it there. No
 * imports and no I/O: the caller passes in what GitHub returned.
 * dork-labs/marketplace shares this file; change it here and re-pin it there,
 * never fork it.
 */

export const REVIEW_LABEL = 'security-reviewed';
export const HOLD_LABEL = 'hold';

/** The one refusal for a Security label someone other than Security put on. */
export const NOT_SECURITY = 'label not applied by Security';

/**
 * The Security account's numeric GitHub user id, from the repo variable
 * `SECURITY_LABELLER_ID`, or `NaN` when it is unset, empty, `0` or anything but
 * a positive integer written plainly. `NaN` refuses every Security label.
 *
 * This is the label route only. The App route is separate: it reads
 * `SECURITY_APPROVAL_BOT_USER_ID` and trusts the commit status the App writes,
 * never a label, and this id plays no part in it.
 */
export function labellerIdOf(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/.test(text)) return NaN;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : NaN;
}

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
 * "A person" is any User account, agents' own included: the Security labels go
 * through {@link securityLabelNewerThanHead}, which also names the account.
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
 * A Security label's check: the actor of its newest `labeled` event is the
 * Security account, compared by numeric `actor.id`, never by login, and the
 * label is newer than every push of `sha` ({@link labelNewerThanHead}). Agents
 * have GitHub accounts of their own, which are Users too, so "a person added
 * it" is no longer enough. An unset or invalid `labellerId`, or a newest event
 * with no readable actor id, refuses.
 *
 * @param {object} input See {@link labelNewerThanHead}, plus:
 * @param {string|number|undefined} input.labellerId The `SECURITY_LABELLER_ID`
 *   repo variable, as the workflow passed it.
 */
export function securityLabelNewerThanHead({ labellerId, ...input }) {
  const { name, labels, timeline } = input;
  if (!labels.some((label) => label.name === name))
    return { passed: false, reason: `no ${name} label` };
  const security = labellerIdOf(labellerId);
  if (Number.isNaN(security))
    return { passed: false, reason: `${NOT_SECURITY}: SECURITY_LABELLER_ID is unset or invalid` };
  const added = timeline.filter((event) => event.event === 'labeled' && event.label?.name === name);
  if (!added.length) return { passed: false, reason: `no ${name} event` };
  const newest = Math.max(...times(added.map((event) => event.created_at)));
  // Only the newest `labeled` event decides: a label removed and added again by
  // anyone else no longer counts, however often Security added it before.
  const latest = added.filter((event) => Date.parse(event.created_at) === newest);
  if (!latest.length || latest.some((event) => event.actor?.id !== security))
    return { passed: false, reason: `${name}: ${NOT_SECURITY}` };
  return labelNewerThanHead(input);
}

/**
 * The gate's check: `security-reviewed`, added by Security, newer than the
 * head, with no `hold`.
 *
 * @param {object} input See {@link securityLabelNewerThanHead}, less `name` and `after`.
 */
export function labelAtHead({ sha, ref, labels, timeline, activity, labellerId }) {
  if (labels.some((label) => label.name === HOLD_LABEL))
    return { passed: false, reason: `the ${HOLD_LABEL} label is on` };
  return securityLabelNewerThanHead({
    name: REVIEW_LABEL,
    sha,
    ref,
    labels,
    timeline,
    activity,
    labellerId,
  });
}
