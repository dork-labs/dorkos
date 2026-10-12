/** Fixed native room seeding for the test-only Hono route, retaining original owner confinement. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { env } from '../env.js';
import { internalGitArgs } from '../lib/git-safety.js';
import { assertRoomRepoConfigSafe } from '../services/rooms/repo/room-repo-git.js';
import { RoomWorktreeManager } from '../services/rooms/repo/room-worktree-manager.js';
import { getRoomAuthors, tryGetRoomWorktreeManager } from '../services/rooms/index.js';

/** Test-only launcher; fixed callers below emulate the missing test-agent shell. */
async function runTestAgentGit(
  checkout: string,
  ceiling: string,
  command: readonly string[]
): Promise<string> {
  if (!env.DORKOS_TEST_RUNTIME)
    throw new Error('Test runtime is required for agent shell seeding.');
  const relative = path.relative(ceiling, checkout);
  const [directory, slug, ...rest] = relative.split(path.sep);
  if (
    rest.length ||
    (directory !== 'repo' && directory !== 'worktrees') ||
    (directory === 'worktrees' && (!slug || slug === '..')) ||
    path.isAbsolute(relative)
  )
    throw new Error('Original manager-selected room layout is required.');
  // eslint-disable-next-line no-restricted-syntax -- preserve child PATH while removing inherited Git redirection.
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const common = path.join(ceiling, 'repo', '.git');
  Object.assign(childEnv, {
    GIT_COMMON_DIR: common,
    GIT_DIR: directory === 'repo' ? common : path.join(common, 'worktrees', slug!),
    GIT_WORK_TREE: checkout,
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  });
  await assertRoomRepoConfigSafe(ceiling);
  const { stdout } = await promisify(execFile)(
    'git',
    [
      ...internalGitArgs(),
      '-c',
      'diff.ignoreSubmodules=all',
      '-c',
      'status.submoduleSummary=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'maintenance.autoDetach=false',
      '-c',
      'gc.autoDetach=false',
      ...command,
    ],
    { cwd: checkout, env: childEnv, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }
  );
  return stdout.trim();
}

/** Select actual manager DATA and seed its fixed agent copy only inside the test router. */
async function prepareTestAgentWorktree(
  manager: RoomWorktreeManager,
  roomId: string,
  agentPath: string,
  agentName: string
) {
  const slug = RoomWorktreeManager.slugFor(agentName, agentPath);
  const existing = await manager.worktreeStatus(roomId, slug);
  if (existing) return { path: existing.path, slug };
  const context = await manager.turnFilesContext(roomId, agentPath, agentName, '');
  if (!context) throw new Error('The original room has no repository for test seeding.');
  const ceiling = path.dirname(context.repoPath),
    checkout = path.join(ceiling, 'worktrees', slug);
  await fs.mkdir(path.dirname(checkout), { recursive: true });
  const branch = await runTestAgentGit(context.repoPath, ceiling, [
    'branch',
    '--list',
    '--format=%(refname)',
    context.branch,
  ]);
  await runTestAgentGit(
    context.repoPath,
    ceiling,
    branch
      ? ['worktree', 'add', '--', checkout, context.branch]
      : ['worktree', 'add', '-b', context.branch, '--', checkout, 'main']
  );
  return { path: checkout, slug };
}

/** Fixed test-agent shell commit; never exported as a product mutation capability. */
async function commitTestAgentWorktree(
  checkout: string,
  agentName: string,
  message: string
): Promise<string> {
  const ceiling = path.resolve(checkout, '..', '..');
  await runTestAgentGit(checkout, ceiling, ['add', '--all']);
  await runTestAgentGit(checkout, ceiling, [
    '-c',
    `user.name=${agentName}`,
    '-c',
    `user.email=${agentName}@dorkos.local`,
    'commit',
    '-m',
    message,
  ]);
  return runTestAgentGit(checkout, ceiling, ['rev-parse', 'HEAD']);
}

/**
 * Mount the exact manager-owned seed handler on the test-only router at its original position.
 * Production does not mount the caller's test-control router; fixed Git also requires test runtime.
 * @param router - The already constructed original Hono test-control router.
 */
export function installTestRoomWorktreeSeedRoute(router: Hono<ApiEnv>): void {
  /** What `POST /api/test/room-worktree-commit` needs to put work in a copy. */
  const roomWorktreeCommitSchema = z.object({
    roomId: z.string().min(1),
    /** The agent whose working copy to commit in, by its project directory. */
    agentPath: z.string().min(1),
    /** The file to write, relative to the working copy's root. */
    path: z.string().min(1),
    /** Its whole contents. */
    text: z.string(),
    /** The commit subject. */
    message: z.string().min(1).default('Work in progress'),
  });

  /**
   * `POST /api/test/room-worktree-commit` — put one commit in an agent's own
   * working copy of a room's files.
   *
   * **The one state a browser cannot reach.** An agent's working copy is written
   * by the agent, with its own shell, inside a turn — and the test-mode runtime
   * has no shell. So a spec about REVIEWING an agent's work (spec
   * `canvas-agent-seat` §8) has no way to produce work to review: the room's diff
   * surface appears only for a copy that is measurably ahead of the room, and
   * nothing a person can press moves that number.
   *
   * It goes through the same {@link RoomWorktreeManager} a turn does, so the
   * directory, the branch and the identity are the ones production writes; only
   * the trigger is scripted. Gated the same way the rest of these routes are:
   * mounted only under `DORKOS_TEST_RUNTIME`, absent in production.
   */
  router.post('/room-worktree-commit', async (c) => {
    const result = roomWorktreeCommitSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { roomId, agentPath, text, message } = result.data;
    const worktrees = tryGetRoomWorktreeManager();
    if (!worktrees) return c.json({ error: 'Room repos are not wired here' }, 409);
    try {
      const agentName = getRoomAuthors().agentNameOf(agentPath);
      if (agentName === null) {
        return c.json({ error: `No agent is registered at ${agentPath}` }, 404);
      }
      const handle = await prepareTestAgentWorktree(worktrees, roomId, agentPath, agentName);
      const target = path.resolve(handle.path, result.data.path);
      const relative = path.relative(handle.path, target);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        return c.json({ error: 'Test file must be inside the agent worktree.' }, 400);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, 'utf-8');
      const commit = await commitTestAgentWorktree(handle.path, agentName, message);
      return c.json({ ok: true, commit, worktree: handle.path, slug: handle.slug });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
