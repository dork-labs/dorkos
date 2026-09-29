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

import { createProjectRootResolver } from '../../../projects/resolve-project-root.js';
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

function rootDeps(resolver: ReturnType<typeof createProjectRootResolver>) {
  return { resolveRoot: resolver.resolve, peekRoot: resolver.peek };
}

/**
 * Spied deps over the real git runner and filesystem. The root comes from the
 * one project-root rule, built fresh with the spied git so its calls count.
 */
function spiedDeps(now: () => number = () => 0) {
  const warn = vi.fn();
  const spiedGit = vi.fn(runGit);
  const deps = {
    ...rootDeps(createProjectRootResolver({ runGit: spiedGit, now })),
    readText: vi.fn((file: string) => readFile(file, 'utf8')),
    log: { warn },
  } satisfies FlowRunLinkDeps;
  return { ...deps, runGit: spiedGit, warn };
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
    expect(runs.get('s-1')).toEqual([
      {
        identifier: 'DOR-1',
        stage: 'execute',
        status: 'running',
        startedAt: '2026-09-26T16:00:00.000Z',
        via: 'this-chat',
        ownChatSessionId: null,
      },
    ]);
  });

  it('resolves a worktree cwd to the main checkout file', async () => {
    writeState({ 'issue-1': run({ sessionId: 's-wt', identifier: 'DOR-9' }) });
    const link = createFlowRunLink(spiedDeps());
    const runs = await link.flowRunsFor(worktree);
    expect(runs.get('s-wt')?.[0]?.identifier).toBe('DOR-9');
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
    expect((await link.flowRunsFor(main)).get('s-1')?.[0]?.stage).toBe('verify');
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
    expect(all.every((runs) => runs.get('s-1')?.[0]?.identifier === 'DOR-1')).toBe(true);
  });

  it('sees a same-size rewrite by rename at the same mtime', async () => {
    const file = path.join(main, '.dork', 'flow', 'flow-state.json');
    const pinned = new Date('2026-09-26T16:00:00.000Z');
    writeState({ 'issue-1': run({ stage: 'execute' }) });
    utimesSync(file, pinned, pinned);
    const link = createFlowRunLink(spiedDeps());
    expect((await link.flowRunsFor(main)).get('s-1')?.[0]?.stage).toBe('execute');
    // Same byte length ("execute" and "decompo" are both 7), same mtime, new inode.
    const next = `${file}.tmp`;
    writeFileSync(next, JSON.stringify({ 'issue-1': run({ stage: 'decompo' }) }));
    utimesSync(next, pinned, pinned);
    renameSync(next, file);
    expect((await link.flowRunsFor(main)).get('s-1')?.[0]?.stage).toBe('decompo');
  });

  it('reads through the real 1 MB capped reader, and a larger file reads as no runs', async () => {
    writeState({ 'issue-1': run({}) });
    const warn = vi.fn();
    const { resolveRoot, peekRoot } = spiedDeps();
    const link = createFlowRunLink({ log: { warn }, resolveRoot, peekRoot });
    expect((await link.flowRunsFor(main)).get('s-1')?.[0]?.identifier).toBe('DOR-1');
    writeState({ 'issue-1': run({ padding: 'x'.repeat(1024 * 1024) }) });
    expect((await link.flowRunsFor(main)).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('applyTrackerItems', () => {
  it('sets trackerItems and the deprecated trackerItem on a session a run names (validation 1)', async () => {
    writeState({ 'issue-1': run({ stage: 'verify', status: 'waiting_for_review' }) });
    const page = [session('s-1', worktree)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page[0].trackerItems).toEqual([
      {
        id: 'DOR-1',
        stage: 'verify',
        runStatus: 'waiting_for_review',
        startedAt: '2026-09-26T16:00:00.000Z',
        via: 'this-chat',
        ownChatSessionId: null,
      },
    ]);
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
    expect(page.every((s) => !('trackerItem' in s) && !('trackerItems' in s))).toBe(true);
  });

  it('keeps every run that names one session, newest first (N9)', async () => {
    writeState({
      'issue-1': run({ startedAt: '2026-09-26T16:00:00.000Z' }),
      'issue-2': run({
        issueId: 'issue-2',
        identifier: 'DOR-2',
        startedAt: '2026-09-26T17:00:00.000Z',
      }),
      'issue-3': run({
        issueId: 'issue-3',
        identifier: 'DOR-3',
        startedAt: '2026-09-26T16:30:00.000Z',
      }),
    });
    const page = [session('s-1', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page[0].trackerItems?.map((item) => item.id)).toEqual(['DOR-2', 'DOR-3', 'DOR-1']);
    expect(page[0].trackerItem?.id).toBe('DOR-2');
  });

  it('orders by parsed time, not by string, and breaks a tie by file order', async () => {
    writeState({
      // The same instant written two ways: string order would put the offset
      // form first; as dates they tie, and the later record in the file wins.
      'issue-1': run({ identifier: 'DOR-1', startedAt: '2026-09-26T18:00:00+02:00' }),
      'issue-2': run({
        issueId: 'issue-2',
        identifier: 'DOR-2',
        startedAt: '2026-09-26T16:00:00.000Z',
      }),
      // Later by time, earlier by string.
      'issue-3': run({
        issueId: 'issue-3',
        identifier: 'DOR-3',
        startedAt: '2026-09-26T19:00:00+02:00',
      }),
    });
    const page = [session('s-1', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page[0].trackerItems?.map((item) => item.id)).toEqual(['DOR-3', 'DOR-2', 'DOR-1']);
  });

  it('lists work a chat dispatched into chats of their own, as own-chat', async () => {
    writeState({
      'issue-1': run({
        sessionId: 'lead',
        identifier: 'DOR-1',
        startedAt: '2026-09-26T15:00:00.000Z',
      }),
      'issue-2': run({
        issueId: 'issue-2',
        identifier: 'DOR-2',
        sessionId: 'worker-dorkos',
        dispatchedBy: 'lead',
        host: 'dorkos',
        startedAt: '2026-09-26T16:00:00.000Z',
      }),
      'issue-3': run({
        issueId: 'issue-3',
        identifier: 'DOR-3',
        sessionId: 'worker-cli',
        dispatchedBy: 'lead',
        host: 'cli',
        startedAt: '2026-09-26T17:00:00.000Z',
      }),
    });
    const page = [session('lead', main), session('worker-dorkos', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(
      page[0].trackerItems?.map(({ id, via, ownChatSessionId }) => ({ id, via, ownChatSessionId }))
    ).toEqual([
      // A chat outside DorkOS has no page to open, so it names no chat.
      { id: 'DOR-3', via: 'own-chat', ownChatSessionId: null },
      { id: 'DOR-2', via: 'own-chat', ownChatSessionId: 'worker-dorkos' },
      { id: 'DOR-1', via: 'this-chat', ownChatSessionId: null },
    ]);
    // The deprecated field keeps its meaning: the newest run IN this chat,
    // never work it started in chats of their own.
    expect(page[0].trackerItem?.id).toBe('DOR-1');
    // The worker's own chat sees its run as its own.
    expect(page[1].trackerItems).toEqual([
      expect.objectContaining({ id: 'DOR-2', via: 'this-chat', ownChatSessionId: null }),
    ]);
  });

  it('leaves the deprecated trackerItem off a chat whose only items run in other chats', async () => {
    writeState({
      'issue-1': run({ sessionId: 'worker', dispatchedBy: 'lead', host: 'dorkos' }),
    });
    const page = [session('lead', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page[0].trackerItems).toEqual([expect.objectContaining({ via: 'own-chat' })]);
    expect('trackerItem' in page[0]).toBe(false);
  });

  it('counts a run dispatched by its own chat once, as this-chat', async () => {
    writeState({ 'issue-1': run({ dispatchedBy: 's-1', host: 'dorkos' }) });
    const page = [session('s-1', main)];
    await createFlowRunLink(spiedDeps()).applyTrackerItems(page);
    expect(page[0].trackerItems).toEqual([
      expect.objectContaining({ id: 'DOR-1', via: 'this-chat', ownChatSessionId: null }),
    ]);
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

describe('applyTrackerItemsLive', () => {
  it('never runs git for a cold folder: it resolves in the background and the next event carries the items', async () => {
    writeState({ 'issue-1': run({}) });
    const deps = spiedDeps();
    const link = createFlowRunLink(deps);
    const first = [session('s-1', worktree)];
    await link.applyTrackerItemsLive(first);
    // Nothing waited on git: the row went out as it was.
    expect('trackerItems' in first[0]).toBe(false);
    // The background resolve lands, and the next live event reads the items.
    await vi.waitFor(() => expect(deps.runGit).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const next = [session('s-1', worktree)];
      await link.applyTrackerItemsLive(next);
      expect(next[0].trackerItems?.[0]?.id).toBe('DOR-1');
    });
    expect(deps.runGit).toHaveBeenCalledTimes(1);
  });

  it('awaits no git call while it waits: peek, not resolve, decides', async () => {
    writeState({ 'issue-1': run({}) });
    let release!: () => void;
    const stalled = new Promise<string | null>((resolve) => (release = () => resolve(main)));
    const link = createFlowRunLink({
      resolveRoot: () => stalled,
      peekRoot: () => undefined,
      readText: (file) => readFile(file, 'utf8'),
      log: { warn: vi.fn() },
    });
    const page = [session('s-1', main)];
    // Resolves even though git never answers.
    await link.applyTrackerItemsLive(page);
    expect('trackerItems' in page[0]).toBe(false);
    release();
  });
});

describe('parseFlowRunState', () => {
  it('accepts a string updatedAt (fleet contract 4.1.0)', () => {
    const state = { 'issue-1': run({ updatedAt: '2026-09-28T10:00:00.000Z' }) };
    expect(parseFlowRunState(JSON.stringify(state))).toEqual(state);
  });

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
    ['a non-string dispatchedBy', { dispatchedBy: 42 }],
    ['a non-string updatedAt (fleet contract 4.1.0)', { updatedAt: 1790000000 }],
  ])('rejects the whole file for %s', (_name, over) => {
    expect(parseFlowRunState(JSON.stringify({ 'issue-1': run(over) }))).toBeNull();
  });

  it('rejects non-object and empty input', () => {
    expect(parseFlowRunState('[]')).toBeNull();
    expect(parseFlowRunState('')).toBeNull();
    expect(parseFlowRunState('null')).toBeNull();
  });
});
