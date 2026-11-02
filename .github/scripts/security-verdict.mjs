/* global console, process */
/**
 * The `security-review` verdict, decided by main's copy of the gate (Security's
 * required-checks plan, step 1, 2026-11-02).
 *
 * `security-gate` runs the PR's own copy of its workflow and scripts, so a PR
 * that edits the gate is judged by its own edit. This runs from
 * `pull_request_target` and `merge_group` with only the BASE commit checked
 * out: the path lists, the label rules and this file are all main's. It never
 * checks out or runs PR code; it reads the PR through the API, as data.
 *
 * What it writes, as the `security-review` commit status:
 * - a head with no security path: `success`, "no security paths" (as the
 *   initializer always has);
 * - a security head in label-at-head mode: `success` when `security-reviewed`
 *   (and `security-deep-reviewed` on a P0 path) is newer than the last push,
 *   from a person, with no `hold`; otherwise `failure`, naming why;
 * - in App mode: the initializer's `pending` only. The App writes the verdict.
 *
 * Until the Security App exists, any workflow file the PR adds or changes that
 * grants `statuses: write`, `checks: write` or `write-all` also needs
 * `security-deep-reviewed`: a workflow with that grant can post this very
 * status itself.
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
import { approvalMode, labelAtHead, labelNewerThanHead } from './security-label-at-head.mjs';

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

/** A permission that lets a workflow post a commit status or a check run. */
const WRITES_A_VERDICT = /^\s*(?:statuses|checks)\s*:\s*write\b|\bpermissions\s*:\s*write-all\b/im;

/**
 * Whether a workflow's text grants a permission that can post a verdict.
 *
 * @param {string} text The workflow file, as YAML text.
 */
export function grantsVerdictWrite(text) {
  return WRITES_A_VERDICT.test(text);
}

/**
 * The workflow files this PR adds or changes that grant `statuses: write`,
 * `checks: write` or `write-all` at its head. Read through the API at the head
 * SHA, never checked out. A file that cannot be read refuses.
 *
 * @param {object} api The GitHub client.
 * @param {{filename: string, status?: string}[]} files The PR's changed files.
 * @param {string} sha The PR head.
 */
export async function verdictWriters(api, files, sha) {
  const writers = [];
  for (const file of files) {
    if (file.status === 'removed' || !WORKFLOW_FILE.test(file.filename)) continue;
    const text = await api.content(file.filename, sha);
    if (typeof text !== 'string') throw new Error(`Cannot read ${file.filename} at ${sha}`);
    if (grantsVerdictWrite(text)) writers.push(file.filename);
  }
  return writers;
}

/**
 * Decide one PR head's label verdict from main's lists. `{ state, description }`,
 * or `null` in App mode for a security head (the App decides).
 *
 * @param {object} api The GitHub client.
 * @param {object} pr The PR, as `GET /pulls/{n}` returns it.
 * @param {object[]} files The PR's changed files.
 * @param {{pattern: string, deepPattern: string, botUserId: string}} lists Main's lists.
 */
export async function headVerdict(api, pr, files, { pattern, deepPattern, botUserId }) {
  if (!deepPattern) throw new Error('Security deep-review path list missing');
  const sha = pr.head.sha;
  const writers = await verdictWriters(api, files, sha);
  const judges = judgeFiles(files);
  const sensitive = touchesSecurity(files, pattern) || writers.length > 0 || judges.length > 0;
  if (!sensitive) return { state: 'success', description: 'no security paths' };
  if (approvalMode(botUserId) !== 'label-at-head') return null;
  const timeline = await api.timeline(pr.number);
  const activity = await api.activity(pr.head.ref);
  const input = { sha, ref: pr.head.ref, labels: pr.labels ?? [], timeline, activity };
  let verdict = labelAtHead(input);
  const deep = touchesSecurity(files, deepPattern) || writers.length > 0 || judges.length > 0;
  if (verdict.passed && deep) verdict = labelNewerThanHead({ ...input, name: DEEP_LABEL });
  if (verdict.passed) return { state: 'success', description: 'Security label covers this SHA' };
  const notes = [];
  if (judges.length) notes.push(`${judges.join(', ')} judges this PR`);
  if (writers.length) notes.push(`${writers.join(', ')} can write statuses or checks`);
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
  const number = event.pull_request.number;
  const sha = event.pull_request.head.sha;
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
 * plus the workflow-grant check on each, then one status on the group's SHA.
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
    await checkMergeGroup(api, event, lists.pattern, lists.botUserId, lists.deepPattern);
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
    const lists = trustedLists();
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
