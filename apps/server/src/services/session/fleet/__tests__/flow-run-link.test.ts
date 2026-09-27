import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '@dorkos/shared/types';

import { runGit } from '../../../workspace/providers/git.js';
import { createFlowRunLink, parseFlowRunState, type FlowRunLinkDeps } from '../flow-run-link.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/** A FlowRun record flow's own schema accepts. */
function run(over: Record<string, unknown>): Record<string, unknown> {
  return {
    issueId: 'issue-1',
    identifier: 'DOR-1',
    sessionId: 's-1',
    worktreePath: '/work/DOR-1',
    branch: 'dor-1',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 1,
    startedAt: '2026-09-26T16:00:00.000Z',
    ...over,
  };
}

function session(id: string, cwd?: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-09-26T16:00:00.000Z',
    updatedAt: '2026-09-26T16:00:00.000Z',
    permissionMode: 'default',
    ...(cwd === undefined ? {} : { cwd }),
  } as Session;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

let root: string;
let main: string;
let worktree: string;
let notARepo: string;

function writeState(state: unknown): void {
  const dir = path.join(main, '.dork', 'flow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'flow-state.json'),
    typeof state === 'string' ? state : JSON.stringify(state)
  );
}

/** Spied deps over the real git runner and filesystem. */
function spiedDeps(now: () => number = () => 0) {
  const warn = vi.fn();
  const deps = {
    runGit: vi.fn(runGit),
    readText: vi.fn((file: string) => readFile(file, 'utf8')),
    log: { warn },
    now,
  } satisfies FlowRunLinkDeps;
  return { ...deps, warn };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flow-run-link-')));
  main = path.join(root, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(
    main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  );
  worktree = path.join(root, 'repo-wt');
  git(main, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  notARepo = path.join(root, 'plain');
  mkdirSync(notARepo);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('flowRunsFor', () => {
  it('maps each run by its session id', async () => {
    writeState({ 'issue-1': run({}) });
    const link = createFlowRunLink(spiedDeps());
    const runs = await link.flowRunsFor(main);
    expect(runs.get('s-1')).toEqual({ identifier: 'DOR-1', stage: 'execute', status: 'running' });
  });

  it('resolves a worktree cwd to the main checkout file', async () => {
    writeState({ 'issue-1': run({ sessionId: 's-wt', identifier: 'DOR-9' }) });
    const link = createFlowRunLink(spiedDeps());
    const runs = await link.flowRunsFor(worktree);
    expect(runs.get('s-wt')?.identifier).toBe('DOR-9');
  });

  it('reads a corrupt file as no runs and logs once per mtime', async () => {
    writeState('{ not json');
    const deps = spiedDeps();
    const link = createFlowRunLink(deps);
    expect((await link.flowRunsFor(main)).size).toBe(0);
    expect((await link.flowRunsFor(main)).size).toBe(0);
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('reads a file with one invalid record as no runs (all-or-nothing, like flow)', async () => {
    writeState({ 'issue-1': run({}), 'issue-2': { issueId: 'issue-2', identifier: 'DOR-2' } });
    const link = createFlowRunLink(spiedDeps());
    expect((await link.flowRunsFor(main)).size).toBe(0);
  });

  it('reads a missing file as no runs without logging', async () => {
    rmSync(path.join(main, '.dork'), { recursive: true, force: true });
    const deps = spiedDeps();
    const link = createFlowRunLink(deps);
    expect((await link.flowRunsFor(main)).size).toBe(0);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('reads a non-git cwd as no runs, and asks git again only after 60 s', async () => {
    let clock = 0;
    const deps = spiedDeps(() => clock);
    const link = createFlowRunLink(deps);
    expect((await link.flowRunsFor(notARepo)).size).toBe(0);
    expect((await link.flowRunsFor(notARepo)).size).toBe(0);
    expect(deps.runGit).toHaveBeenCalledTimes(1);
    clock = 60_001;
    await link.flowRunsFor(notARepo);
    expect(deps.runGit).toHaveBeenCalledTimes(2);
  });

  it('re-reads the file only when it changes', async () => {
    writeState({ 'issue-1': run({}) });
    const deps = spiedDeps();
    const link = createFlowRunLink(deps);
    await link.flowRunsFor(main);
    await link.flowRunsFor(main);
    expect(deps.readText).toHaveBeenCalledTimes(1);
    // A later mtime, as flow's rename-into-place gives.
    writeState({ 'issue-1': run({ stage: 'verify' }) });
    const later = new Date(Date.now() + 5_000);
    utimesSync(path.join(main, '.dork', 'flow', 'flow-state.json'), later, later);
    expect((await link.flowRunsFor(main)).get('s-1')?.stage).toBe('verify');
    expect(deps.readText).toHaveBeenCalledTimes(2);
  });
  it('shares one git lookup between concurrent calls for one cwd', async () => {
    writeState({ 'issue-1': run({}) });
    const deps = spiedDeps();
    const link = createFlowRunLink(deps);
    const all = await Promise.all([
      link.flowRunsFor(worktree),
      link.flowRunsFor(worktree),
      link.flowRunsFor(worktree),
    ]);
    expect(deps.runGit).toHaveBeenCalledTimes(1);
    expect(all.every((runs) => runs.get('s-1')?.identifier === 'DOR-1')).toBe(true);
  });

  it('sees a same-size rewrite by rename at the same mtime', async () => {
    const file = path.join(main, '.dork', 'flow', 'flow-state.json');
    const pinned = new Date('2026-09-26T16:00:00.000Z');
    writeState({ 'issue-1': run({ stage: 'execute' }) });
    utimesSync(file, pinned, pinned);
    const link = createFlowRunLink(spiedDeps());
    expect((await link.flowRunsFor(main)).get('s-1')?.stage).toBe('execute');
    // Same byte length ("execute" and "decompo" are both 7), same mtime, new inode.
    const next = `${file}.tmp`;
    writeFileSync(next, JSON.stringify({ 'issue-1': run({ stage: 'decompo' }) }));
    utimesSync(next, pinned, pinned);
    renameSync(next, file);
    expect((await link.flowRunsFor(main)).get('s-1')?.stage).toBe('decompo');
  });

  it('reads through the real 1 MB capped reader, and a larger file reads as no runs', async () => {
    writeState({ 'issue-1': run({}) });
    const warn = vi.fn();
    const link = createFlowRunLink({ log: { warn } });
    expect((await link.flowRunsFor(main)).get('s-1')?.identifier).toBe('DOR-1');
    writeState({ 'issue-1': run({ padding: 'x'.repeat(1024 * 1024) }) });
    expect((await link.flowRunsFor(main)).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('applyTrackerItems', () => {
  it('sets trackerItem on a session a run names (validation 1)', async () => {
    writeState({ 'issue-1': run({ stage: 'verify', status: 'waiting_for_review' }) });
    const page = [session('s-1', worktree)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page[0].trackerItem).toEqual({
      id: 'DOR-1',
      stage: 'verify',
      runStatus: 'waiting_for_review',
    });
  });

  it('a fresh instance reads the link again (validation 2: survives a restart)', async () => {
    writeState({ 'issue-1': run({}) });
    const before = [session('s-1', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(before);
    const after = [session('s-1', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(after);
    expect(after[0].trackerItem).toEqual({ id: 'DOR-1', stage: 'execute', runStatus: 'running' });
  });

  it('leaves a session no run names deep-equal to before (validation 3)', async () => {
    writeState({ 'issue-1': run({}) });
    const page = [session('other', main), session('no-cwd'), session('plain', notARepo)];
    const snapshot = structuredClone(page);
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page).toEqual(snapshot);
    expect(page.every((s) => !('trackerItem' in s))).toBe(true);
  });

  it('prefers the most recently started run when two name one session', async () => {
    writeState({
      'issue-1': run({ startedAt: '2026-09-26T16:00:00.000Z' }),
      'issue-2': run({
        issueId: 'issue-2',
        identifier: 'DOR-2',
        startedAt: '2026-09-26T17:00:00.000Z',
      }),
    });
    const page = [session('s-1', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page[0].trackerItem?.id).toBe('DOR-2');
  });

  it('asks git once per distinct cwd and reads the file once', async () => {
    writeState({ 'issue-1': run({}) });
    const deps = spiedDeps();
    const link = createFlowRunLink(deps);
    const page = [
      session('s-1', main),
      session('a', main),
      session('b', main),
      session('c', worktree),
      session('d'),
    ];
    await link.applyTrackerItems(page);
    expect(deps.runGit).toHaveBeenCalledTimes(2);
    expect(deps.readText).toHaveBeenCalledTimes(1);
    await link.applyTrackerItems(page);
    expect(deps.runGit).toHaveBeenCalledTimes(2);
    expect(deps.readText).toHaveBeenCalledTimes(1);
  });
});

describe('parseFlowRunState', () => {
  it('returns records unchanged, unknown fields included', () => {
    const state = { 'issue-1': run({ checkpoint: { ref: 'abc' }, host: 'future' }) };
    expect(parseFlowRunState(JSON.stringify(state))).toEqual(state);
  });

  it.each([
    ['a non-string host', { host: 3 }],
    ['a non-string account', { account: { id: 'x' } }],
    ['a non-string runtime', { runtime: 7 }],
    ['a missing sessionId', { sessionId: undefined }],
    ['a negative attemptCount', { attemptCount: -1 }],
  ])('rejects the whole file for %s', (_name, over) => {
    expect(parseFlowRunState(JSON.stringify({ 'issue-1': run(over) }))).toBeNull();
  });

  it('rejects non-object and empty input', () => {
    expect(parseFlowRunState('[]')).toBeNull();
    expect(parseFlowRunState('')).toBeNull();
    expect(parseFlowRunState('null')).toBeNull();
  });
});
