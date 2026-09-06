/**
 * Whose session is it, when the folder has two names? (DOR-695)
 *
 * The fan-out compares two strings that arrive from different places: a
 * session's `cwd`, which every runtime with a real store derives from the
 * directory its process ran in — the REAL path — and an agent's registered
 * project directory, which is whatever string was typed. On macOS `/tmp` and
 * `/var` are symlinks, so those are routinely two names for one folder, and
 * the session was dropped from the sidebar's Recent list and the Activity
 * counts even after the adapter had found it.
 *
 * Driven over a REAL symlink on disk, because a mocked `realpath` would only
 * echo back the assumption under test.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session } from '@dorkos/shared/types';
import { fanOutAgentSessions, setAgentSessionSources } from '../agent-session-fanout.js';

let base: string;
let realProject: string;
let linkedProject: string;
let realWorktree: string;
let linkedWorktree: string;

beforeAll(async () => {
  // `realpath` the temp root first: on macOS `os.tmpdir()` is itself under the
  // `/var` symlink, and a fixture that is accidentally non-canonical would make
  // every assertion below mean something other than what it says.
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-fanout-spelling-')));
  realProject = path.join(base, 'real-project');
  await mkdir(path.join(realProject, 'packages', 'api'), { recursive: true });
  linkedProject = path.join(base, 'linked-project');
  await symlink(realProject, linkedProject);
  realWorktree = path.join(base, 'real-worktree');
  await mkdir(realWorktree);
  linkedWorktree = path.join(base, 'linked-worktree');
  await symlink(realWorktree, linkedWorktree);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

afterEach(() => {
  setAgentSessionSources(null);
});

/** A session as a runtime with a real store reports it: `cwd` is the REAL path. */
function session(id: string, cwd: string): Session {
  return {
    id,
    title: id,
    cwd,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'opencode',
  };
}

/**
 * A runtime that answers every project directory with the same rows — the
 * adapter half is already fixed and tested elsewhere, so what is under test
 * here is purely what the fan-out does with the rows it gets.
 */
function runtimeReturning(sessions: Session[]): AgentRuntime {
  return {
    type: 'opencode',
    listSessions: vi.fn(async () => sessions),
    getInternalSessionId: vi.fn(() => undefined),
  } as unknown as AgentRuntime;
}

/** The member ids the fan-out attributed to `agentPath`. */
async function membersFor(agentPath: string, sessions: Session[]): Promise<string[]> {
  const { perPath } = await fanOutAgentSessions({
    runtimes: [runtimeReturning(sessions)],
    agentPaths: [agentPath],
  });
  return (perPath[0]?.members ?? []).map((s) => s.id);
}

describe('agent session fan-out across directory spellings (DOR-695)', () => {
  it('has a fixture whose two spellings really are one folder', async () => {
    // If this ever stops holding, every case below is asserting nothing.
    expect(linkedProject).not.toBe(realProject);
    await expect(realpath(linkedProject)).resolves.toBe(realProject);
  });

  it('attributes a session to an agent registered under the symlinked spelling', async () => {
    await expect(membersFor(linkedProject, [session('s1', realProject)])).resolves.toEqual(['s1']);
  });

  it('attributes a session running in a SUBFOLDER of the symlinked project', async () => {
    const sub = path.join(realProject, 'packages', 'api');
    await expect(membersFor(linkedProject, [session('s1', sub)])).resolves.toEqual(['s1']);
  });

  it('attributes a room-worktree session when the extra root is symlinked too', async () => {
    setAgentSessionSources({
      extraDirs: async () => [linkedWorktree],
      boundSessionIds: async () => new Set<string>(),
    });

    await expect(membersFor(linkedProject, [session('s1', realWorktree)])).resolves.toEqual(['s1']);
  });

  it('attributes a session whose OWN cwd is the symlink, to an agent registered by the real path', async () => {
    // The reverse direction, and it is producible: a session tracked in memory
    // carries the cwd it was created with, and `sendMessage` falls back to
    // `DEFAULT_CWD` — `DORKOS_DEFAULT_CWD` taken verbatim. So the row the
    // OpenCode adapter now returns can be the one spelling the folder the
    // symlinked way, against a root spelled the real way.
    await expect(membersFor(realProject, [session('s1', linkedProject)])).resolves.toEqual(['s1']);
  });

  it('attributes a session in a SUBFOLDER reached through the symlink', async () => {
    const subViaLink = path.join(linkedProject, 'packages', 'api');
    await expect(membersFor(realProject, [session('s1', subViaLink)])).resolves.toEqual(['s1']);
  });

  it('still attributes a session whose cwd matches the registered spelling exactly', async () => {
    // The pre-fix behaviour, which must survive: a session tracked in memory
    // carries the cwd it was created with, not a resolved one.
    await expect(membersFor(linkedProject, [session('s1', linkedProject)])).resolves.toEqual([
      's1',
    ]);
    await expect(membersFor(realProject, [session('s1', realProject)])).resolves.toEqual(['s1']);
  });

  it('still refuses a sibling directory that merely shares a name prefix', async () => {
    const sibling = path.join(base, 'real-project-2');
    await mkdir(sibling, { recursive: true });

    await expect(membersFor(linkedProject, [session('s1', sibling)])).resolves.toEqual([]);
  });

  it('still refuses a cwd-less row rather than fanning it into every agent', async () => {
    // DOR-202: a ghost session belongs to no project list.
    const ghost = { ...session('s1', realProject), cwd: undefined };
    await expect(membersFor(linkedProject, [ghost])).resolves.toEqual([]);
  });
});
