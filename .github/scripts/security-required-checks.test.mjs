/* global URL */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { labelAtHead } from './security-label-at-head.mjs';
import { LABEL_RERUN_CONTEXTS, lastRequiredCheck } from './security-required-checks.mjs';

const SHA = 'head1';
const EARLY = '2026-11-08T10:00:00Z';
const LATE = '2026-11-08T11:00:00Z';
const labelled = (at) => ({
  event: 'labeled',
  label: { name: 'security-reviewed' },
  created_at: at,
  actor: { type: 'User' },
});
const label = (at, after) =>
  labelAtHead({
    sha: SHA,
    ref: 'fix/checks',
    labels: [{ name: 'security-reviewed' }],
    timeline: [labelled(at)],
    activity: [{ after: SHA, ref: 'refs/heads/fix/checks', timestamp: EARLY }],
    after,
  });
const run = (name, at, extra = {}) => ({
  name,
  status: 'completed',
  conclusion: 'success',
  completed_at: at,
  ...extra,
});
const status = (context, at, state = 'success') => ({ context, state, created_at: at });

test('a label before test finished is refused and names test', () => {
  const last = lastRequiredCheck({
    contexts: ['test'],
    checkRuns: [run('test', LATE)],
    statuses: [],
    sha: SHA,
  });
  assert.equal(last.name, 'test');
  assert.equal(label(EARLY, [last.at]).passed, false);
});

test('a missing required context refuses', () => {
  assert.deepEqual(
    lastRequiredCheck({
      contexts: ['test', 'browser-test'],
      checkRuns: [run('test', EARLY)],
      statuses: [],
      sha: SHA,
    }),
    {
      passed: false,
      reason: `browser-test has not reported at ${SHA}`,
      name: 'browser-test',
    }
  );
});

test('a pending check run and a pending status refuse', () => {
  for (const input of [
    {
      checkRuns: [
        run('test', undefined, {
          status: 'in_progress',
          conclusion: null,
          started_at: LATE,
        }),
      ],
      statuses: [],
    },
    { checkRuns: [], statuses: [status('test', LATE, 'pending')] },
  ]) {
    assert.match(
      lastRequiredCheck({ contexts: ['test'], sha: SHA, ...input }).reason,
      /test has not finished/
    );
  }
});

test('a failed check refuses; skipped and neutral checks pass', () => {
  const failed = lastRequiredCheck({
    contexts: ['test'],
    checkRuns: [run('test', LATE, { conclusion: 'failure' })],
    statuses: [],
    sha: SHA,
  });
  assert.match(failed.reason, /test did not pass/);
  for (const conclusion of ['skipped', 'neutral']) {
    assert.equal(
      lastRequiredCheck({
        contexts: ['test'],
        checkRuns: [run('test', LATE, { conclusion })],
        statuses: [],
        sha: SHA,
      }).passed,
      true,
      conclusion
    );
  }
});

test('a context reported only as a commit status uses its status time', () => {
  const last = lastRequiredCheck({
    contexts: ['test'],
    checkRuns: [],
    statuses: [status('test', LATE)],
    sha: SHA,
  });
  assert.deepEqual(last, {
    passed: true,
    reason: 'required checks passed',
    at: LATE,
    name: 'test',
  });
});

test('the newest run wins, so a re-run after the label refuses', () => {
  const last = lastRequiredCheck({
    contexts: ['test'],
    checkRuns: [run('test', EARLY), run('test', LATE)],
    statuses: [],
    sha: SHA,
  });
  assert.equal(last.at, LATE);
  assert.equal(label('2026-11-08T10:30:00Z', [last.at]).passed, false);
});

test('label-triggered required contexts are ignored even when they finish later', () => {
  const last = lastRequiredCheck({
    contexts: ['test', ...LABEL_RERUN_CONTEXTS],
    checkRuns: [run('test', EARLY), ...LABEL_RERUN_CONTEXTS.map((context) => run(context, LATE))],
    statuses: [],
    sha: SHA,
  });
  assert.equal(last.name, 'test');
  assert.equal(last.at, EARLY);
});

test('a label after every required check passes', () => {
  const last = lastRequiredCheck({
    contexts: ['test', 'browser-test'],
    checkRuns: [run('test', EARLY), run('browser-test', '2026-11-08T10:30:00Z')],
    statuses: [],
    sha: SHA,
  });
  assert.equal(label(LATE, [last.at]).passed, true);
});

test('mutant guard: only label time versus lastRequired changes the verdict', () => {
  const last = lastRequiredCheck({
    contexts: ['test'],
    checkRuns: [run('test', '2026-11-08T10:30:00Z')],
    statuses: [],
    sha: SHA,
  });
  assert.equal(label('2026-11-08T10:29:59Z', [last.at]).passed, false);
  assert.equal(label('2026-11-08T10:30:01Z', [last.at]).passed, true);
});

test('label-triggered required workflow contexts stay equal to the exclusion list', () => {
  const required = JSON.parse(
    readFileSync(new URL('../../ci/required-checks.json', import.meta.url), 'utf8')
  ).contexts;
  const requiredContexts = new Set([...required, 'security-gate']);
  const found = new Set();
  const workflows = new URL('../workflows/', import.meta.url);
  for (const name of readdirSync(workflows).filter((file) => file.endsWith('.yml'))) {
    const lines = readFileSync(new URL(name, workflows), 'utf8').split('\n');
    const pullRequest = lines.findIndex((line) => line === '  pull_request:');
    if (pullRequest === -1) continue;
    const eventEnd = lines.findIndex((line, index) => index > pullRequest && /^ {2}\S/.test(line));
    const event = lines.slice(pullRequest, eventEnd === -1 ? lines.length : eventEnd).join('\n');
    if (!/^ {4}types: \[[^\]]*\blabeled\b/m.test(event)) continue;
    const jobs = lines.findIndex((line) => line === 'jobs:');
    if (jobs === -1) continue;
    for (let index = jobs + 1; index < lines.length; index += 1) {
      const key = /^ {2}([\w-]+):\s*$/.exec(lines[index])?.[1];
      const display = /^ {4}name:\s*['"]?([^'"#]+?)['"]?\s*$/.exec(lines[index])?.[1];
      for (const context of [key, display]) {
        if (requiredContexts.has(context)) found.add(context);
      }
    }
  }
  assert.deepEqual([...found].sort(), [...LABEL_RERUN_CONTEXTS].sort());
});
