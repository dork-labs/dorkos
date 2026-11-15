/* global console, fetch, process, setTimeout, URL */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  HOLD_LABEL,
  REVIEW_LABEL,
  approvalMode,
  labelAtHead,
  labelNewerThanHead,
} from './security-label-at-head.mjs';
import { REQUIRED_RULESET_NAME, lastRequiredCheck } from './security-required-checks.mjs';

const CONTEXT = 'security-review';

/**
 * The second label a P0 identity path needs at its head (#dorkos, 2026-11-02 02:04):
 * Security's deep review, on top of `security-reviewed`. A push voids it the same way.
 */
export const DEEP_LABEL = 'security-deep-reviewed';

/** The workflow is the sole security-path list, shared by both read-only tools. */
export function securityPathPattern() {
  const text = readFileSync(new URL('../workflows/security-gate.yml', import.meta.url), 'utf8');
  const pattern = /^ {2}SECURITY_PATH_PATTERN: '(.+)'$/m.exec(text)?.[1];
  if (!pattern) throw new Error('Security path list missing');
  return pattern;
}

/** The P0 deep-review list, read from the same workflow file as {@link securityPathPattern}. */
export function securityDeepPathPattern() {
  const text = readFileSync(new URL('../workflows/security-gate.yml', import.meta.url), 'utf8');
  const pattern = /^ {2}SECURITY_DEEP_PATH_PATTERN: '(.+)'$/m.exec(text)?.[1];
  if (!pattern) throw new Error('Security deep-review path list missing');
  return pattern;
}

/** The approval mode's bot id, read from the same workflow file, never from the event. */
export function trustedBotUserId() {
  const text = readFileSync(new URL('../workflows/security-gate.yml', import.meta.url), 'utf8');
  return /^ {2}SECURITY_APPROVAL_BOT_USER_ID: '([^']+)'$/m.exec(text)?.[1];
}

/** GitHub returns statuses newest first. An older success never overrides a refusal. */
export function latestReview(statuses) {
  return statuses.find((status) => status.context === CONTEXT);
}

// Match marketplace S3b's expansion fold in addition to RegExp's simple Unicode
// fold (notably sharp-s -> ss). Keep the original path: folding only adds matches.
function fullFold(path) {
  return path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

export function touchesSecurity(files, pattern) {
  const exact = new RegExp(pattern);
  const matcher = new RegExp(pattern, 'iu');
  return files.some((file) =>
    [file.filename, file.previous_filename].some(
      (path) =>
        path &&
        // Flags can remove matches for lookaheads and negated classes. Preserve
        // the original flagless verdict before adding folded matches.
        (exact.test(path) ||
          [path, fullFold(path), fullFold(path.normalize('NFKC'))].some((form) =>
            matcher.test(form)
          ))
    )
  );
}

/** Walk the queue's commit chain, rather than trusting the PR number in its ref.
 * A cumulative group includes earlier entries, even with a one-PR merge limit.
 * Missing/dequeued/rebuilt entries fail closed instead of approving an old group.
 */
export function groupMembers(entries, group) {
  const members = [];
  const seen = new Set();
  let head = group.head_sha;
  while (head !== group.base_sha) {
    if (seen.has(head)) throw new Error('Cycle in merge queue');
    seen.add(head);
    const matches = entries.filter((entry) => entry.headCommit?.oid === head);
    if (matches.length !== 1) throw new Error(`Cannot resolve queued commit ${head}`);
    const entry = matches[0];
    if (!entry.pullRequest?.headRefOid || !entry.baseCommit?.oid)
      throw new Error('Incomplete queue entry');
    members.unshift(entry);
    head = entry.baseCommit.oid;
  }
  if (!members.length) throw new Error('Empty merge group');
  return members;
}

function hasApproval(review, sensitive, botUserId) {
  if (review?.state !== 'success') return false;
  // Preserve the trusted initializer's automatic classification, never a user's
  // imitation. Sensitive approvals always require the dedicated App.
  if (!sensitive && review.description === 'no security paths')
    return review.creator?.login === 'github-actions[bot]';
  return Boolean(
    Number.isSafeInteger(Number(botUserId)) &&
    Number(botUserId) > 0 &&
    review.creator?.id === Number(botUserId) &&
    review.description !== 'no security paths'
  );
}

/**
 * Why an open PR is only waiting for Security, or `null` when it is not: a label
 * it needs has never been put on, and nothing is wrong (no `hold`, no stale or
 * bot label). Main's `security-review` still refuses it; this keeps the PR's own
 * check from going red over a review that simply has not happened yet (Security's
 * required-checks plan, step 4).
 *
 * @param {object} pr The PR, as `GET /pulls/{n}` returns it.
 * @param {object} input The label-at-head input.
 * @param {boolean} deep Whether the diff touches a P0 identity path.
 */
function awaitingReview(pr, input, deep) {
  if (pr.merged_at || pr.state === 'closed') return null;
  const has = (name) => input.labels.some((label) => label.name === name);
  if (has(HOLD_LABEL)) return null;
  if (!has(REVIEW_LABEL)) return `no ${REVIEW_LABEL} label yet`;
  if (deep && !has(DEEP_LABEL) && labelAtHead(input).passed) return `no ${DEEP_LABEL} label yet`;
  return null;
}

/** The labels the verdict judges. Any label change makes it write a new status; these change its answer. */
const VERDICT_LABELS = [REVIEW_LABEL, DEEP_LABEL, HOLD_LABEL];

/** The one base main's verdict judges (`security-review-initialize.yml` runs only for it). */
const VERDICT_BASE = 'main';

/**
 * How long a PR run waits for main's verdict on its head (DOR-3710). The gate and
 * `security-review-initialize` start on the same label event, and the gate read
 * the old status 1-5s before the verdict wrote the new one, so the first run
 * after a label went red. One 90s deadline covers the whole run, base-move
 * restarts included, so the script refuses with its own message well inside
 * the job's 5 minutes.
 */
export const VERDICT_POLL = {
  intervalMs: 5000,
  timeoutMs: 90_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * The time main's verdict for this head must be newer than: the newest change to
 * a label it reads, a force push or base change on the timeline, the head's
 * newest push in the activity feed, and `floor`, the triggering event's
 * `pull_request.updated_at`, in case its own label event is not on the timeline
 * yet. NaN when any is unreadable or the push is missing, which refuses.
 */
export function verdictDue({ sha, ref, timeline, activity }, floor) {
  const pushes = activity
    .filter((entry) => entry.after === sha && entry.ref === `refs/heads/${ref}`)
    .map((entry) => entry.timestamp);
  if (!pushes.length) return NaN;
  const changes = timeline
    .filter(
      (event) =>
        (['labeled', 'unlabeled'].includes(event.event) &&
          VERDICT_LABELS.includes(event.label?.name)) ||
        ['head_ref_force_pushed', 'base_ref_changed'].includes(event.event)
    )
    .map((event) => event.created_at);
  return Math.max(...[...pushes, ...changes, floor].map((value) => Date.parse(value)));
}

/**
 * The PR run's label-at-head verdict: the labels it can see must cover the head,
 * and then main's `security-review` must say `success` in a status written after
 * {@link verdictDue}. A stale or pending status is polled, never judged on; when
 * the bound runs out it refuses. A status is read for this exact SHA only.
 */
async function judgeFreshReview(api, sha, input, deep, wait, lastRequired) {
  const verdict = labelsAfterRequired(input, deep, lastRequired);
  if (!verdict.passed) return verdict;
  const due = verdictDue(input, wait.eventTime);
  if (Number.isNaN(due))
    return { passed: false, reason: `cannot read when ${sha}'s labels or push last changed` };
  for (let poll = 1; ; poll += 1) {
    const review = latestReview(await api.statuses(sha));
    // One line per read, so a job log shows whether the wait ran and how long.
    console.log(
      `security-review poll ${poll}: ${review ? `${review.state} at ${review.created_at}` : 'no status'}; needs a finished status newer than ${new Date(due).toISOString()}`
    );
    if (review && review.state !== 'pending' && Date.parse(review.created_at) > due)
      return review.state === 'success'
        ? verdict
        : { passed: false, reason: `security-review is ${review.state}` };
    if (!(wait.now() + wait.intervalMs <= wait.deadline))
      return {
        passed: false,
        reason: `security-review verdict not yet written for this head (none newer than ${new Date(due).toISOString()}); rerun security-review-initialize, then security-gate`,
      };
    await wait.sleep(wait.intervalMs);
  }
}

function labelsAfterRequired(input, deep, lastRequired) {
  let verdict = labelAtHead(input);
  if (!verdict.passed) return verdict;
  verdict = labelAtHead({ ...input, after: [lastRequired.at] });
  if (!verdict.passed)
    return {
      passed: false,
      reason: `${REVIEW_LABEL} went on before the last required check (${lastRequired.name}) finished; remove it and add it again`,
    };
  if (!deep) return verdict;
  verdict = labelNewerThanHead({ ...input, name: DEEP_LABEL });
  if (!verdict.passed) return verdict;
  verdict = labelNewerThanHead({
    ...input,
    name: DEEP_LABEL,
    after: [lastRequired.at],
  });
  if (!verdict.passed)
    return {
      passed: false,
      reason: `${DEEP_LABEL} went on before the last required check (${lastRequired.name}) finished; remove it and add it again`,
    };
  return verdict;
}

async function requiredAtHead(api, sha, statuses) {
  const rulesets = await api.rulesets();
  if (!Array.isArray(rulesets)) throw new Error('Incomplete ruleset list');
  const matches = rulesets.filter((ruleset) => ruleset?.name === REQUIRED_RULESET_NAME);
  if (matches.length !== 1)
    throw new Error(
      `${matches.length ? 'More than one' : 'No'} ruleset named ${REQUIRED_RULESET_NAME}`
    );
  const ruleset = await api.ruleset(matches[0].id);
  if (!Array.isArray(ruleset?.rules)) throw new Error('Incomplete required ruleset');
  const contexts = [];
  for (const rule of ruleset.rules.filter(
    (candidate) => candidate?.type === 'required_status_checks'
  )) {
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) throw new Error('Incomplete required status checks');
    for (const check of checks) {
      if (typeof check?.context !== 'string' || !check.context)
        throw new Error('Incomplete required status check');
      contexts.push(check.context);
    }
  }
  if (!contexts.length) throw new Error(`No required checks in ${REQUIRED_RULESET_NAME}`);
  return lastRequiredCheck({
    contexts: [...new Set(contexts)],
    checkRuns: await api.checkRuns(sha),
    statuses,
    sha,
  });
}

/** A Security label put on after the PR merged, which reviewed nothing. `null` if none. */
function labelAfterMerge(pr, timeline) {
  if (!pr.merged_at) return null;
  const merged = Date.parse(pr.merged_at);
  const late = timeline.find(
    (event) =>
      event.event === 'labeled' &&
      [REVIEW_LABEL, DEEP_LABEL].includes(event.label?.name) &&
      !(Date.parse(event.created_at) <= merged)
  );
  return late ? `${late.label.name} was added after the merge` : null;
}

/**
 * Label-at-head for a sensitive diff while no App is set; App mode everywhere else.
 * A diff on a P0 identity path (`deep`) also needs {@link DEEP_LABEL} at the head.
 * With `waitForReview`, an open PR that is only waiting for its labels passes as
 * `{ passed: true, waiting }`, and one into main whose labels cover it waits for
 * main's fresh verdict (`wait`, see {@link VERDICT_POLL}). A PR into any other base
 * gets no verdict to wait for and keeps the old lines; the merge queue never sets it.
 */
async function verifyApproval(
  api,
  number,
  sha,
  review,
  sensitive,
  botUserId,
  deep = false,
  waitForReview = false,
  wait = undefined,
  statuses = [],
  requireFreshChecks = true
) {
  if (!sensitive || approvalMode(botUserId) !== 'label-at-head') {
    const passed = hasApproval(review, sensitive, botUserId);
    return { passed, reason: 'security-review pending' };
  }
  const timeline = await api.timeline(number);
  const pr = await api.pr(number);
  const activity = await api.activity(pr.head.ref);
  const input = { sha, ref: pr.head.ref, labels: pr.labels ?? [], timeline, activity };
  const late = labelAfterMerge(pr, timeline);
  if (late) return { passed: false, reason: late };
  const waiting = waitForReview && awaitingReview(pr, input, deep);
  if (waiting) return { passed: true, waiting };
  const lastRequired = requireFreshChecks ? await requiredAtHead(api, sha, statuses) : undefined;
  if (lastRequired && !lastRequired.passed) return lastRequired;
  if (waitForReview && pr.base?.ref === VERDICT_BASE)
    return judgeFreshReview(api, sha, input, deep, wait, lastRequired);
  // The merge queue, and a PR into another base, judge the status they read,
  // unchanged by DOR-3710.
  // The initializer's pending is every sensitive head's start; a refusal still refuses.
  if (review && review.state !== 'pending' && review.state !== 'success')
    return { passed: false, reason: `security-review is ${review.state}` };
  if (!lastRequired) {
    const verdict = labelAtHead(input);
    if (!verdict.passed || !deep) return verdict;
    return labelNewerThanHead({ ...input, name: DEEP_LABEL });
  }
  return labelsAfterRequired(input, deep, lastRequired);
}

/** Whether a diff touches a P0 identity path. No list refuses, never reads as none. */
function touchesDeep(files, deepPattern) {
  if (!deepPattern) throw new Error('Security deep-review path list missing');
  return touchesSecurity(files, deepPattern);
}

function validateFiles(files) {
  if (
    !Array.isArray(files) ||
    files.some(
      (file) =>
        !file ||
        typeof file.filename !== 'string' ||
        !file.filename ||
        (file.previous_filename !== undefined && typeof file.previous_filename !== 'string')
    ) ||
    new Set(files.map((file) => file.filename)).size !== files.length
  )
    throw new Error('Incomplete or invalid file list');
  return files;
}

/**
 * A PR's whole changed-file list, refusing a truncated or malformed one.
 *
 * @param {object} api The GitHub client.
 * @param {number} number The PR number.
 * @param {{changed_files: number}} pr The PR, for its file count.
 * @param {string} pattern The security path list; a missing one refuses.
 */
export async function prFiles(api, number, pr, pattern) {
  if (!pattern) throw new Error('Security path list missing');
  const files = await api.files(number);
  // The files endpoint is capped at 3,000; never classify a truncated diff as safe.
  if (
    !Number.isSafeInteger(pr.changed_files) ||
    pr.changed_files < 0 ||
    pr.changed_files >= 3000 ||
    validateFiles(files).length !== pr.changed_files
  )
    throw new Error('Incomplete PR file list');
  return files;
}

/** How many times a PR run starts over when its base moves under it. */
const BASE_MOVE_RUNS = 3;

/**
 * The PR verifier, and the initializer's write. A base that moves mid-run, as a
 * stacked layer's does whenever its parent is pushed, starts the run over on the
 * current base (DOR-3680); a head that moves still refuses.
 *
 * @param {object} api The GitHub client.
 * @param {object} event The `pull_request` or `pull_request_target` event.
 * @param {string} pattern The security path list.
 * @param {object} [options] `write`, `requireApproval`, `botUserId`, `deepPattern`, and
 *   `poll` to override {@link VERDICT_POLL}.
 */
export async function checkPullRequest(api, event, pattern, options = {}) {
  // One deadline for every run below, so restarts never stack their waits.
  const wait = { ...VERDICT_POLL, ...options.poll, eventTime: event.pull_request.updated_at };
  wait.deadline = wait.now() + wait.timeoutMs;
  for (let run = 1; ; run += 1) {
    const result = await checkPullRequestOnce(api, event, pattern, { ...options, wait });
    if (!result.baseMoved) return result.said;
    if (run === BASE_MOVE_RUNS)
      throw new Error(`PR #${event.pull_request.number} base kept moving; rerun security-gate`);
  }
}

async function checkPullRequestOnce(
  api,
  event,
  pattern,
  { write = false, requireApproval = true, botUserId, deepPattern, wait }
) {
  const number = event.pull_request.number;
  const sha = event.pull_request.head.sha;
  const pr = await api.pr(number);
  if (pr.head.sha !== sha) throw new Error(`PR #${number} head moved`);
  const files = await prFiles(api, number, pr, pattern);
  const sensitive = touchesSecurity(files, pattern);
  const statuses = await api.statuses(sha);
  let review = latestReview(statuses);
  if (write && (!sensitive || !hasApproval(review, sensitive, botUserId))) {
    const state = sensitive ? 'pending' : 'success';
    if (
      review?.state !== state ||
      (!sensitive &&
        (review?.description !== 'no security paths' ||
          review?.creator?.login !== 'github-actions[bot]'))
    ) {
      review = await api.setStatus(
        sha,
        state,
        sensitive ? 'Security approval required for this SHA' : 'no security paths'
      );
    }
  }
  if (write) await audit(api, number, sha, review, botUserId);
  // Only ABSENT status permits computed clearance. Never bypass an explicit
  // pending/failure (or reused automatic approval on a now-sensitive diff).
  const computed = !write && !review && !sensitive;
  const verdict =
    requireApproval && !computed
      ? await verifyApproval(
          api,
          number,
          sha,
          review,
          sensitive,
          botUserId,
          sensitive && touchesDeep(files, deepPattern),
          true,
          wait,
          statuses
        )
      : { passed: true };
  const current = await api.pr(number);
  if (current.head.sha !== sha) throw new Error(`PR #${number} head moved`);
  // The files and the verdict were read against the old base: judge the new one.
  if (current.base.ref !== pr.base.ref || current.base.sha !== pr.base.sha)
    return { baseMoved: true };
  if (!verdict.passed)
    throw new Error(
      `PR #${number}: ${verdict.reason} on ${sha}; Security must approve, then rerun security-gate`
    );
  if (verdict.waiting)
    return {
      said: `Waiting for Security: ${verdict.waiting} on ${sha}. security-review decides; it is not success yet`,
    };
  return { said: computed ? 'no security paths (computed)' : 'Security status verified' };
}

export async function queuedSensitiveDiff(api, base, sha, pattern) {
  return touchesSecurity(await queuedFiles(api, base, sha, pattern), pattern);
}

/** The files a queued entry changes, compared between its pinned base and head. */
async function queuedFiles(api, base, sha, pattern) {
  if (!base || !sha || !pattern) throw new Error('Missing immutable comparison input');
  const comparison = await api.compare(base, sha);
  // Compare files appear only on page 1 and are capped at 300, independently
  // of commit pagination. At the cap completeness is unknown, so refuse.
  const files = validateFiles(comparison.files);
  if (
    comparison.base_commit?.sha !== base ||
    comparison.merge_base_commit?.sha !== base ||
    files.length >= 300
  )
    throw new Error('Incomplete queued-head comparison');
  return files;
}

async function audit(api, number, sha, review, botUserId) {
  // The creator is the status author, NOT the person who triggered this run.
  const marker = `<!-- security-gate:${sha}:${review?.state ?? 'missing'} -->`;
  const prefix = `<!-- security-gate:${sha}:`;
  const previous = (await api.comments(number))
    .filter(
      (comment) => comment.user?.login === 'github-actions[bot]' && comment.body.includes(prefix)
    )
    .at(-1);
  if (previous?.body.includes(marker)) return;
  const rule =
    approvalMode(botUserId) === 'label-at-head'
      ? `No Security App is set: sensitive approvals require a security-reviewed label newer than the last push, with no hold label. A P0 identity path also needs ${DEEP_LABEL}, newer than the last push. Both labels must also be newer than the last required check to finish at that head.`
      : 'Sensitive approvals require the configured Security App as status creator. The security-reviewed label is a human signal only.';
  await api.comment(
    number,
    `Security gate: \`${CONTEXT} = ${review?.state ?? 'missing'}\` on \`${sha}\`, set by @${review?.creator?.login ?? 'unknown'}. Status id: ${review?.id ?? 'unknown'}.\n${marker}\n\n${rule}`
  );
}

/**
 * How long a merge-group run re-reads the queue for its own commit (DOR-3564).
 * A group stacked on another entry's group starts its run before GitHub fills
 * in its entry's `headCommit`: 20-30s after creation the walk found nothing and
 * the gate refused a group that had done nothing wrong. Only that one miss is
 * re-read; every other refusal stands, and when the time runs out it still fails
 * closed with the same message. 60s keeps the run well inside the job's limit.
 */
export const QUEUE_POLL = {
  intervalMs: 5000,
  timeoutMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Resolve the group's entries, re-reading the queue only while its commit is not in it yet. */
async function resolveGroup(api, group, poll) {
  const deadline = poll.now() + poll.timeoutMs;
  for (;;) {
    try {
      return groupMembers(await api.queue(group.base_ref), group);
    } catch (error) {
      const notYet = /^Cannot resolve queued commit /.test(error.message);
      if (!notYet || !(poll.now() + poll.intervalMs <= deadline)) throw error;
      // One line per read, so a job log shows whether the re-read ran and how long.
      console.log(`${error.message}; reading the merge queue again in ${poll.intervalMs / 1000}s`);
      await poll.sleep(poll.intervalMs);
    }
  }
}

export async function checkMergeGroup(api, event, pattern, botUserId, deepPattern, options = {}) {
  const group = event.merge_group;
  const members = await resolveGroup(api, group, { ...QUEUE_POLL, ...options.poll });
  const results = [];
  for (const entry of members) {
    const { number, headRefOid: sha } = entry.pullRequest;
    const pr = await api.pr(number);
    if (pr.base.ref !== group.base_ref.replace(/^refs\/heads\//, ''))
      throw new Error(`PR #${number} base moved`);
    // Never borrow the current PR's files for the queued commit. Both SHA
    // arguments are pinned by the merge-group event/entry snapshot.
    const files = await queuedFiles(api, entry.baseCommit.oid, entry.headCommit.oid, pattern);
    const sensitive = touchesSecurity(files, pattern);
    const statuses = await api.statuses(sha);
    const review = latestReview(statuses);
    const computed = !review && !sensitive;
    const verdict = computed
      ? { passed: true }
      : await verifyApproval(
          api,
          number,
          sha,
          review,
          sensitive,
          botUserId,
          sensitive && touchesDeep(files, deepPattern),
          false,
          undefined,
          statuses,
          options.requiredChecks !== false
        );
    if (!verdict.passed)
      throw new Error(
        `PR #${number}: no security-review success on ${sha}; pending Security approval (${verdict.reason})`
      );
    const current = await api.pr(number);
    if (pr.head.sha !== sha || current.head.sha !== sha)
      throw new Error(`PR #${number} head moved`);
    if (current.base.ref !== pr.base.ref || current.base.sha !== pr.base.sha)
      throw new Error(`PR #${number} base moved`);
    results.push(
      `PR #${number}: ${computed ? 'no security paths (computed)' : 'Security status verified'}`
    );
  }
  // The merge-queue run re-judges every queued PR, so a required check re-run
  // after the label refuses here until the PR is re-labelled. A check_suite
  // trigger cannot enforce that: GitHub does not start workflows for check
  // suites that GitHub Actions created.
  // A push can dequeue/rebuild an entry while statuses are being read.
  const current = groupMembers(await api.queue(group.base_ref), group);
  if (JSON.stringify(current) !== JSON.stringify(members))
    throw new Error('Merge queue changed during security review');
  return results.join('\n');
}

/** Minimal GitHub client. Follow every page; API errors never become empty results. */
export function githubApi(repository, token, apiUrl = 'https://api.github.com') {
  const root = `${apiUrl}/repos/${repository}`;
  async function request(url, body) {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} at ${new URL(url).pathname}`);
    return {
      data: await response.json(),
      next: /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1],
    };
  }
  async function pages(path, key) {
    const values = [];
    const seen = new Set();
    let url = `${root}${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (url) {
      if (seen.has(url)) throw new Error('Repeated pagination cursor');
      seen.add(url);
      const result = await request(url);
      const page = key ? result.data?.[key] : result.data;
      if (!Array.isArray(page)) throw new Error('Incomplete GitHub list response');
      values.push(...page);
      url = result.next;
    }
    return values;
  }
  return {
    pr: async (number) => (await request(`${root}/pulls/${number}`)).data,
    files: (number) => pages(`/pulls/${number}/files`),
    compare: async (base, sha) =>
      (
        await request(
          `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(sha)}?per_page=1&page=1`
        )
      ).data,
    statuses: (sha) => pages(`/commits/${sha}/statuses`),
    checkRuns: (sha) => pages(`/commits/${encodeURIComponent(sha)}/check-runs`, 'check_runs'),
    rulesets: () => pages('/rulesets'),
    ruleset: async (id) => (await request(`${root}/rulesets/${encodeURIComponent(id)}`)).data,
    setStatus: async (sha, state, description) =>
      (await request(`${root}/statuses/${sha}`, { context: CONTEXT, state, description })).data,
    timeline: (number) => pages(`/issues/${number}/timeline`),
    commit: async (sha) => (await request(`${root}/commits/${encodeURIComponent(sha)}`)).data,
    // Not a bare list, so not `pages`. One page of 100; a longer list refuses.
    async checkSuites(sha) {
      const { data } = await request(
        `${root}/commits/${encodeURIComponent(sha)}/check-suites?per_page=100`
      );
      if (!Array.isArray(data.check_suites) || data.total_count !== data.check_suites.length)
        throw new Error('Incomplete check suite list');
      return data.check_suites;
    },
    activity: (ref) => pages(`/activity?ref=${encodeURIComponent(ref)}`),
    comments: (number) => pages(`/issues/${number}/comments`),
    comment: (number, body) => request(`${root}/issues/${number}/comments`, { body }),
    async queue(baseRef) {
      const [owner, name] = repository.split('/');
      const entries = [];
      let after = null;
      do {
        const { data: result } = await request(`${apiUrl}/graphql`, {
          query: `query($owner:String!,$name:String!,$branch:String!,$after:String) {
            repository(owner:$owner,name:$name) { mergeQueue(branch:$branch) {
              entries(first:100,after:$after) { nodes {
                baseCommit { oid } headCommit { oid } pullRequest { number headRefOid }
              } pageInfo { hasNextPage endCursor } }
            } }
          }`,
          variables: { owner, name, branch: baseRef.replace(/^refs\/heads\//, ''), after },
        });
        if (result.errors) throw new Error('GitHub merge queue query failed');
        const page = result.data?.repository?.mergeQueue?.entries;
        if (!page) throw new Error('Merge queue unavailable');
        entries.push(...page.nodes);
        if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
          throw new Error('Missing queue cursor');
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return entries;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const api = githubApi(
      process.env.GITHUB_REPOSITORY,
      process.env.GH_TOKEN,
      process.env.GITHUB_API_URL
    );
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      if (!process.env.SECURITY_PATH_PATTERN) throw new Error('Security path list missing');
      console.log(
        await checkPullRequest(api, event, process.env.SECURITY_PATH_PATTERN, {
          botUserId: process.env.SECURITY_APPROVAL_BOT_USER_ID,
          deepPattern: process.env.SECURITY_DEEP_PATH_PATTERN,
        })
      );
    } else if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
      // The base-copy writer is security-verdict.mjs, in its own workflow and
      // identity; this verifier never writes.
      throw new Error('pull_request_target runs security-verdict.mjs, not the verifier');
    } else if (process.env.GITHUB_EVENT_NAME === 'merge_group') {
      console.log(
        await checkMergeGroup(
          api,
          event,
          process.env.SECURITY_PATH_PATTERN,
          process.env.SECURITY_APPROVAL_BOT_USER_ID,
          process.env.SECURITY_DEEP_PATH_PATTERN
        )
      );
    } else {
      throw new Error('Unsupported security gate event');
    }
    console.log('Security gate passed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  // The verifier's env names the mode; the initializer has no bot id here and writes no summary.
  if (process.env.GITHUB_STEP_SUMMARY && process.env.SECURITY_APPROVAL_BOT_USER_ID) {
    const mode = approvalMode(process.env.SECURITY_APPROVAL_BOT_USER_ID);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Security gate mode: **${mode}**\n`);
  }
}
