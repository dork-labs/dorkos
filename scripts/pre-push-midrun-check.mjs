#!/usr/bin/env node
// Pre-push guard: don't push while CI is still running from the last push.
//
//   node scripts/pre-push-midrun-check.mjs
//   CI_PUSH_ANYWAY=1 git push      # push anyway
//
// WHY THIS EXISTS
//
// `test` and `browser-test` group their `pull_request` runs per PR with
// `cancel-in-progress: true`, so every push cancels the runs still going on the
// previous head. From 2026-11-12 00Z to 2026-11-15 16Z that threw away 74
// job-hours of PR runs in those two workflows (CI Steward's Nov 15 read). Most
// were a fix commit pushed a few minutes after the last one. Waiting for the
// red, or batching the next commit, costs the pusher little and the shared
// runner pool a lot.
//
// It is a nudge, not a gate. It tests nothing and proves nothing (DOR-2160:
// nothing at push claims to have tested anything). It refuses only while a run
// on this branch is queued or in progress and under ten minutes old; past that
// the run has spent most of what it will spend on a PR leg and the push is
// cheaper than the wait. Everything that goes wrong (no gh, no auth, no
// network, a slow answer, a detached HEAD, output it cannot read) prints one
// line and lets the push through.
//
// It skips without asking GitHub when the push cannot cancel anything on this
// branch: on `main`, and when HEAD already equals the remote-tracking ref (a
// delete-only push, or a push of some other ref). It takes no stdin: the
// pre-push hook deliberately gives the ref list to nobody.
//
// The gh calls run in parallel under one hard limit (4 s, or
// CI_MIDRUN_TIMEOUT_MS) measured by node itself, so it needs no GNU `timeout`.

import { spawn, spawnSync } from 'node:child_process';

const WORKFLOWS = ['test.yml', 'browser-test.yml'];
const WINDOW_MINUTES = 10;
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const TIMEOUT_MS = Number(process.env.CI_MIDRUN_TIMEOUT_MS) || 4000;

/**
 * Prints one warning line and lets the push through.
 *
 * @param {string} why - What went wrong, in a few words.
 */
function letThrough(why) {
  console.log(`pre-push midrun: ${why}; not checking for running CI.`);
  process.exit(0);
}

/**
 * Runs git and returns its trimmed stdout, or undefined when git fails.
 *
 * @param {string[]} args - Arguments to git.
 * @returns {string | undefined} The output, or undefined on failure.
 */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * Asks gh for the latest runs of one workflow on a branch.
 *
 * Resolves on the child's exit rather than on its pipes closing, so a gh that
 * leaves a grandchild holding stdout cannot hold the push past the limit.
 *
 * @param {string} workflow - The workflow file name.
 * @param {string} branch - The branch to ask about.
 * @returns {Promise<{ ok: true, runs: unknown } | { ok: false, why: string }>} The parsed runs, or why not.
 */
function runList(workflow, branch) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(
        'gh',
        [
          'run',
          'list',
          '--workflow',
          workflow,
          '--branch',
          branch,
          '--limit',
          '5',
          '--json',
          'status,createdAt,databaseId',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch {
      resolve({ ok: false, why: 'gh could not start' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, why: `gh did not answer within ${TIMEOUT_MS} ms` });
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, why: 'gh is not installed' });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Give the pipe a tick to flush what the child already wrote.
      setImmediate(() => {
        if (code !== 0) {
          resolve({ ok: false, why: `gh exited ${code ?? 'on a signal'} (signed in?)` });
          return;
        }
        try {
          resolve({ ok: true, runs: JSON.parse(out) });
        } catch {
          resolve({ ok: false, why: 'gh printed something that is not JSON' });
        }
      });
    });
  });
}

if (process.env.CI_PUSH_ANYWAY === '1') process.exit(0);

const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
if (!branch) letThrough('detached HEAD');
if (branch === 'main') process.exit(0);

const head = git(['rev-parse', 'HEAD']);
const pushed = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
if (head && pushed && head === pushed) process.exit(0);

const results = await Promise.all(WORKFLOWS.map((wf) => runList(wf, branch)));
const failed = results.find((r) => !r.ok);
if (failed) letThrough(failed.why);

const now = Date.now();
const running = [];
for (const [i, result] of results.entries()) {
  if (!Array.isArray(result.runs)) letThrough('gh printed an unexpected shape');
  for (const run of result.runs) {
    const created = Date.parse(run?.createdAt);
    if (!ACTIVE.has(run?.status) || Number.isNaN(created)) continue;
    const minutes = Math.max(0, Math.floor((now - created) / 60_000));
    if (minutes < WINDOW_MINUTES) running.push({ workflow: WORKFLOWS[i], minutes, run });
  }
}

if (running.length === 0) process.exit(0);

console.log(`\ngit push refused: CI from your last push to ${branch} is still running.\n`);
for (const { workflow, minutes, run } of running) {
  console.log(
    `  * ${workflow} — ${run.status}, started ${minutes} min ago (run ${run.databaseId})`
  );
}
console.log(
  '\nPushing now cancels those runs and throws away the job-hours they have spent.\n' +
    `Wait for them to finish (or pass ${WINDOW_MINUTES} minutes), or batch your next commit.\n` +
    'To push anyway:  CI_PUSH_ANYWAY=1 git push\n'
);
process.exit(1);
