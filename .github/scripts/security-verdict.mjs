/* global console, process */
/**
 * The `security-review` verdict, decided by main's copy of the gate (Security's
 * required-checks plan, step 1, 2026-11-02).
 *
 * `security-gate` runs the PR's own copy of its workflow and scripts, so a PR
 * that edits the gate is judged by its own edit. This runs from
 * `pull_request_target` with `refs/heads/main` checked out, and from
 * `merge_group` with the group's base commit: the path lists, the label rules and
 * this file are all main's. It never checks out or runs PR code; it reads the PR
 * through the API, as data. A PR into any branch but main gets `failure`, "base is
 * not main": that branch's copy of this script must never be the judge.
 *
 * What it writes, as the `security-review` commit status:
 * - a head with no security path: `success`, "no security paths" (as the
 *   initializer always has);
 * - a security head in label-at-head mode: `success` when `security-reviewed`
 *   (and `security-deep-reviewed` on a P0 path) is newer than the last push,
 *   its newest `labeled` event is from the account `SECURITY_LABELLER_ID`
 *   names (by numeric id), and there is no `hold`; otherwise `failure`, naming
 *   why. An unset or invalid variable fails every security head;
 * - in App mode: the initializer's `pending` only. The App writes the verdict.
 *
 * Until the Security App exists, any workflow file the PR adds, changes, renames
 * or removes also needs `security-deep-reviewed`. A workflow with
 * `statuses: write` can post this very status itself, and YAML has too many ways
 * to spell that grant to read it reliably, so every workflow edit counts.
 *
 * A PR from a fork cannot pass: its pushes are not in this repository's
 * activity feed, so the push time is unknown and the label verdict refuses.
 *
 * A PR that edits a file that judges it (this workflow, the gate's workflow or a
 * `.github/scripts/security-*` script) also needs `security-deep-reviewed`: in the
 * queue the workflow file comes from the merge commit, so such a PR could rewrite
 * the job that judges it. It fails on its own head, before anything can queue it.
 *
 * On `merge_group` it judges every queued PR the way `security-gate` does, with
 * main's lists, and posts the verdict on the merge group's own SHA, so a
 * required `security-review` never leaves the queue waiting on "expected".
 *
 * What this does not fix: on `merge_group` the workflow file itself comes from
 * the merge commit, which includes the PR. Only the ruleset can pin it to main.
 *
 * @module security-verdict
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEEP_LABEL,
  checkMergeGroup,
  checkPullRequest,
  githubApi,
  groupMembers,
  prFiles,
  securityDeepPathPattern,
  securityPathPattern,
  touchesSecurity,
  trustedBotUserId,
} from './security-gate.mjs';
import {
  approvalMode,
  labelAtHead,
  securityLabelNewerThanHead,
} from './security-label-at-head.mjs';

/** The one branch this gate judges PRs into. */
const MAIN = 'main';

/** A workflow file, by path. Reusable workflows live here too. */
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

/**
 * The files that judge a PR: this workflow, the gate's own workflow (its path
 * lists) and the gate's scripts. In the queue the workflow file comes from the
 * merge commit, so a PR that edits one of these could rewrite the job that
 * judges it. Such a PR needs `security-deep-reviewed` on its own head.
 */
const JUDGE_FILE =
  /^\.github\/(?:workflows\/(?:security-review-initialize|security-gate)\.ya?ml|scripts\/security-[^/]*)$/i;

/**
 * The workflow files a PR touches, either side of a rename, removals included.
 *
 * @param {{filename: string, previous_filename?: string}[]} files The PR's changed files.
 */
export function workflowFiles(files) {
  return files
    .filter((file) =>
      [file.filename, file.previous_filename].some((path) => path && WORKFLOW_FILE.test(path))
    )
    .map((file) => file.filename);
}

/**
 * The judging files a PR touches, either side of a rename.
 *
 * @param {{filename: string, previous_filename?: string}[]} files The PR's changed files.
 */
export function judgeFiles(files) {
  return files
    .filter((file) =>
      [file.filename, file.previous_filename].some((path) => path && JUDGE_FILE.test(path))
    )
    .map((file) => file.filename);
}

/**
 * Decide one PR head's label verdict from main's lists. `{ state, description }`,
 * or `null` in App mode for a security head (the App decides).
 *
 * @param {object} api The GitHub client.
 * @param {object} pr The PR, as `GET /pulls/{n}` returns it.
 * @param {object[]} files The PR's changed files.
 * @param {{pattern: string, deepPattern: string, botUserId: string, labellerId?: string}} lists
 *   Main's lists, and the `SECURITY_LABELLER_ID` repo variable.
 */
export async function headVerdict(api, pr, files, { pattern, deepPattern, botUserId, labellerId }) {
  if (!deepPattern) throw new Error('Security deep-review path list missing');
  const sha = pr.head.sha;
  const workflows = workflowFiles(files);
  const judges = judgeFiles(files);
  const sensitive = touchesSecurity(files, pattern) || workflows.length > 0 || judges.length > 0;
  if (!sensitive) return { state: 'success', description: 'no security paths' };
  if (approvalMode(botUserId) !== 'label-at-head') return null;
  const timeline = await api.timeline(pr.number);
  const activity = await api.activity(pr.head.ref);
  const input = { sha, ref: pr.head.ref, labels: pr.labels ?? [], timeline, activity, labellerId };
  let verdict = labelAtHead(input);
  const deep = touchesSecurity(files, deepPattern) || workflows.length > 0 || judges.length > 0;
  if (verdict.passed && deep) verdict = securityLabelNewerThanHead({ ...input, name: DEEP_LABEL });
  if (verdict.passed) return { state: 'success', description: 'Security label covers this SHA' };
  const notes = [];
  if (judges.length) notes.push(`${judges.join(', ')} judges this PR`);
  const others = workflows.filter((file) => !judges.includes(file));
  if (others.length) notes.push(`${others.join(', ')} is a workflow`);
  const why = [verdict.reason, ...notes].join('; ');
  // GitHub caps a status description at 140 characters.
  return { state: 'failure', description: why.slice(0, 140) };
}

/**
 * The `pull_request_target` run: the initializer's write (pending, or success
 * on no security paths), then the label verdict on the same head. A head that
 * moved while it read writes nothing; the run for the newer head decides.
 *
 * @param {object} api The GitHub client.
 * @param {object} event The `pull_request_target` event.
 * @param {{pattern: string, deepPattern: string, botUserId: string}} lists Main's lists.
 * @returns {Promise<string>} What it wrote, for the log.
 */
export async function verdictForPullRequest(api, event, lists) {
  const sha = event.pull_request.head.sha;
  try {
    return await decidePullRequest(api, event, lists);
  } catch (error) {
    // Any error is a refusal, never a stale pending or success left standing.
    await api.setStatus(sha, 'failure', `verdict errored: ${error.message}`.slice(0, 140));
    throw error;
  }
}

/**
 * The pull-request verdict proper; `verdictForPullRequest` turns its errors into failure.
 *
 * @param {object} api The GitHub client.
 * @param {object} event The `pull_request_target` event.
 * @param {{pattern: string, deepPattern: string, botUserId: string}} lists Main's lists.
 */
async function decidePullRequest(api, event, lists) {
  const number = event.pull_request.number;
  const sha = event.pull_request.head.sha;
  // Only main has this gate's rules and the merge queue. A PR into any other
  // branch is never judged here, and never left looking judged.
  const base = event.pull_request.base?.ref;
  const target = (await api.pr(number)).base?.ref;
  if (base !== MAIN || target !== MAIN) {
    const description = `base is not ${MAIN} (${[base, target].find((ref) => ref !== MAIN) ?? 'unknown'}); retarget to ${MAIN} to be judged`;
    await api.setStatus(sha, 'failure', description.slice(0, 140));
    return `PR #${number}: security-review failure on ${sha} (${description})`;
  }
  try {
    await checkPullRequest(api, event, lists.pattern, {
      write: true,
      requireApproval: false,
      botUserId: lists.botUserId,
    });
  } catch (error) {
    // A push between the event and this run: the run for that push decides.
    if (/head moved/.test(error.message))
      return `PR #${number} moved past ${sha}; the newer run decides`;
    throw error;
  }
  const pr = await api.pr(number);
  if (pr.head.sha !== sha) return `PR #${number} moved past ${sha}; the newer run decides`;
  const files = await prFiles(api, number, pr, lists.pattern);
  const verdict = await headVerdict(api, pr, files, lists);
  if (!verdict) return `PR #${number}: App mode, the App decides ${sha}`;
  const current = await api.pr(number);
  if (current.head.sha !== sha) return `PR #${number} moved past ${sha}; the newer run decides`;
  await api.setStatus(sha, verdict.state, verdict.description);
  return `PR #${number}: security-review ${verdict.state} on ${sha} (${verdict.description})`;
}

/**
 * The `merge_group` run: every queued PR judged as `security-gate` judges it,
 * plus the workflow and judge-file checks on each, then one status on the group's SHA.
 *
 * @param {object} api The GitHub client.
 * @param {object} event The `merge_group` event.
 * @param {{pattern: string, deepPattern: string, botUserId: string}} lists Main's lists.
 * @returns {Promise<string>} What it wrote, for the log.
 */
export async function verdictForMergeGroup(api, event, lists) {
  const group = event.merge_group;
  let state = 'success';
  let description = 'Security label covers every queued PR';
  try {
    await checkMergeGroup(api, event, lists.pattern, lists.botUserId, lists.deepPattern, {
      labellerId: lists.labellerId,
    });
    for (const entry of groupMembers(await api.queue(group.base_ref), group)) {
      const { number, headRefOid } = entry.pullRequest;
      const pr = await api.pr(number);
      if (pr.head.sha !== headRefOid) throw new Error(`PR #${number} head moved`);
      const files = await prFiles(api, number, pr, lists.pattern);
      const verdict = await headVerdict(api, pr, files, lists);
      if (verdict && verdict.state !== 'success')
        throw new Error(`PR #${number}: ${verdict.description}`);
    }
  } catch (error) {
    state = 'failure';
    description = String(error.message).slice(0, 140);
  }
  await api.setStatus(group.head_sha, state, description);
  return `merge group ${group.head_sha}: security-review ${state} (${description})`;
}

/** Main's lists and mode, read from the checked-out base commit, never the event or env. */
export function trustedLists() {
  return {
    pattern: securityPathPattern(),
    deepPattern: securityDeepPathPattern(),
    botUserId: trustedBotUserId(),
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
    // The Security account's id is a repo variable, not a line in a file, so it
    // comes from this workflow's env (`vars.SECURITY_LABELLER_ID`). On
    // `pull_request_target` that env is main's copy of the workflow; a PR cannot
    // set it. Unset or invalid refuses every Security label.
    const lists = { ...trustedLists(), labellerId: process.env.SECURITY_LABELLER_ID };
    if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
      console.log(await verdictForPullRequest(api, event, lists));
    } else if (process.env.GITHUB_EVENT_NAME === 'merge_group') {
      console.log(await verdictForMergeGroup(api, event, lists));
    } else {
      throw new Error('The verdict runs only on pull_request_target and merge_group');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
