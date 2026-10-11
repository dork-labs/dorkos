import type {
  ConnectorRuntimeRequestProbe,
  ConnectorRuntimeExecutionProbe,
} from '../services/runtimes/test-mode/connector-runtime-probe-contract.js';
export type {
  ConnectorRuntimeRequestProbe,
  ConnectorRuntimeExecutionProbe,
} from '../services/runtimes/test-mode/connector-runtime-probe-contract.js';
import { Router } from 'express';
import path from 'path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import { seedAgentFace } from '@dorkos/shared/agent-face';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { TestModeRuntime } from '../services/runtimes/test-mode/test-mode-runtime.js';
import {
  ConnectorAgentConnectionRequestInputSchema,
  ConnectorExecutionTargetSchema,
} from '@dorkos/shared/connector-schemas';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import { getBoundary, validateBoundary } from '../lib/boundary.js';
import { localDialHost } from '../lib/local-dial-host.js';
import { env } from '../env.js';
import { heldProcesses } from '../services/runtimes/test-mode/held-process.js';
import { interactionGate } from '../services/runtimes/test-mode/interaction-gate.js';
import {
  declareInterruptOutcome,
  requestFinishTurn,
  scenarioStore,
} from '../services/runtimes/test-mode/scenario-store.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { getRoomAuthors, tryGetRoomWorktreeManager } from '../services/rooms/index.js';
import { assertRoomRepoConfigSafe } from '../services/rooms/repo/room-repo-git.js';
import { internalGitArgs } from '../lib/git-safety.js';
import { RoomWorktreeManager } from '../services/rooms/repo/room-worktree-manager.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAgentIdentityService } from '../services/core/agent-identity/agent-identity-service.js';
import { hashApprovalInput, type ApprovalService } from '../services/core/approvals/index.js';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';
import { MOCK_MCP_OAUTH_MCP_PATH, resetMockMcpOAuthState } from './mock-mcp-oauth-server.js';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import { getRemoteConnectionStore } from '../services/communities/remote/state.js';
import type { AgentMcpServerService } from '../services/mesh/agent-mcp-server-service.js';
import { installTestAgentSeedRoutes } from './test-agent-seed-routes.js';

/**
 * Control routes for TestModeRuntime. Only mounted when DORKOS_TEST_RUNTIME=true.
 * Returns 404 for any /api/test/* path in production (route not registered).
 */
export const testControlRouter = Router();

let remoteCommunitySubscriptionProbe: ((ref: string, roomId: string) => unknown) | undefined;

/** Bind the private replay barrier after the room subsystem completes startup. */
export function setRemoteCommunitySubscriptionProbe(
  next: ((ref: string, roomId: string) => unknown) | undefined
): void {
  remoteCommunitySubscriptionProbe = next;
}

const remoteCommunitySubscriptionQuerySchema = z
  .object({ ref: z.string().min(1), roomId: z.string().min(1) })
  .strict();

/** Test-only owner-qualified replay barrier. Production never mounts this router. */
testControlRouter.get('/community-subscription', (req, res) => {
  const parsed = remoteCommunitySubscriptionQuerySchema.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: 'A community ref and roomId are required.' });
  if (!remoteCommunitySubscriptionProbe)
    return res.status(503).json({ error: 'Community subscription probe is unavailable.' });
  const value = remoteCommunitySubscriptionProbe(parsed.data.ref, parsed.data.roomId);
  if (!value) return res.status(404).json({ error: 'Community room subscription is unavailable.' });
  return res.json(value);
});

/**
 * Make the real Community connection store commit a change, so the real
 * `community_connections_changed` broadcast goes out on `/api/events`.
 *
 * A browser proof cannot end a real Community connection — that needs a live
 * Community host — so it mocks the connection LIST and asks here for the
 * server's push. The push is content-free (a stamp only), so which owner's
 * list changed does not matter to a window: a throwaway pending row, owned by
 * a key no local author can have, is added and removed through the same store
 * methods every pairing, expiry and disconnect uses. Nothing is left behind.
 */
testControlRouter.post('/community-connection-change', async (_req, res) => {
  const store = getRemoteConnectionStore();
  const ownerKey = 'e2e-connection-change-probe';
  const ref = CommunityRefSchema.parse(`remote_probe_${ulid().toLowerCase()}`);
  await store.addPending(
    {
      ref,
      ownerKey,
      remoteCommunityId: 'e2e-probe',
      label: 'Probe',
      pinnedOrigin: 'https://probe.example.test',
      pairingId: 'e2e-probe',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    'e2e-probe-verifier'
  );
  await store.disconnect(ref, ownerKey);
  res.json({ ok: true });
});

const scenarioSchema = z.object({
  name: z.string().min(1),
  sessionId: z.string().uuid().optional(),
});

testControlRouter.post('/scenario', (req, res) => {
  const result = scenarioSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  const { name, sessionId } = result.data;
  try {
    if (sessionId) {
      scenarioStore.setForSession(sessionId, name);
    } else {
      scenarioStore.setDefault(name);
    }
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
  res.json({ ok: true, scenario: name });
});

const canonicalIdSchema = z.object({
  sessionId: z.string().uuid(),
  canonicalId: z.string().uuid(),
  runtime: z.string().min(1).optional(),
});

/**
 * `POST /api/test/canonical-id` — declare the id this session's FIRST turn will
 * rename it to (DOR-2015).
 *
 * A brand-new claude-code session streams under the request UUID the client
 * minted and is renamed to the SDK's own id mid-first-turn. That rename moves
 * the projector, the lock, the route the window is on — and the session's
 * canvas. Test mode has no SDK to mint an id, so before this there was no way to
 * reach the rename from a browser at all, and the canvas's survival across it
 * was pinned only below the browser.
 *
 * Declaring costs nothing until the session's next turn starts: the runtime goes
 * on reporting no canonical id, so the turn begins under the id the client
 * minted exactly as a real one does, and the rename lands mid-turn.
 *
 * Refuses a session bound to a runtime that is not test-mode, for the reason
 * `POST /persistent` gives: a silent no-op here would surface as a spec waiting
 * for a rename that was never going to happen.
 */
testControlRouter.post('/canonical-id', async (req, res) => {
  const result = canonicalIdSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  const { sessionId, canonicalId, runtime } = result.data;
  // A draft is not bound yet; declare on the runtime its first send will choose.
  const resolved = await resolveTestModeRuntime(sessionId, runtime);
  if ('error' in resolved) return res.status(resolved.status).json({ error: resolved.error });
  resolved.runtime.declareCanonicalSessionId(sessionId, canonicalId);
  res.json({ ok: true, sessionId, canonicalId });
});

/**
 * `POST /api/test/finish-turn` — end every running `long-turn` at its next
 * heartbeat.
 *
 * A lever for ending a turn on the test's schedule WITHOUT stopping it. Stop is
 * a different thing and now genuinely works (`interruptQuery` aborts the
 * scenario, DOR-1214), but it ends the turn as `aborted_streaming` — which is
 * the wrong terminal state for a test watching a queue drain into the NEXT turn.
 * This lets the turn finish normally instead. The alternative, picking a turn
 * short enough to wait out, races the test's own setup.
 *
 * Process-wide and sticky, unlike `POST /api/test/step`; see `requestFinishTurn`.
 */
testControlRouter.post('/finish-turn', (_req, res) => {
  requestFinishTurn();
  res.json({ ok: true });
});

const interruptOutcomeSchema = z.object({
  outcome: z.enum(['acked', 'closed', 'unconfirmed', 'failed']).nullable(),
});

/**
 * `POST /api/test/interrupt-outcome` — declare which of the five stop endings
 * the next Stop on a scripted turn answers with (spec
 * `runtime-interrupt-receipts` D10).
 *
 * The endings a real runtime only produces under conditions a browser test
 * cannot arrange — an agent that acks, a runtime that declines, a call that
 * blows up — staged deterministically so the composer's per-outcome copy can be
 * asserted. `outcome: null` restores test-mode's honest `closed` default.
 *
 * `unconfirmed` and `failed` do NOT stop the turn: they stage the ending a stop
 * that did not land produces, and a turn that quietly ended underneath that copy
 * would prove nothing about it.
 *
 * Process-wide and sticky, like `POST /api/test/finish-turn`.
 */
testControlRouter.post('/interrupt-outcome', (req, res) => {
  const result = interruptOutcomeSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  declareInterruptOutcome(result.data.outcome ?? undefined);
  res.json({ ok: true, outcome: result.data.outcome });
});

const stepSchema = z.object({ sessionId: z.string().uuid() });

/**
 * `POST /api/test/step` — release ONE step barrier on a session's running
 * scenario (DOR-1214).
 *
 * The clock a browser test needs when what it is watching is a PROGRESSION
 * rather than a single blocking ask: todos advancing pending → in_progress →
 * completed, sub-agents starting and settling, a turn held open long enough for
 * Stop to have something real to stop. The alternative is racing a paced
 * scenario's own timers, which is how a test ends up asserting whichever frame
 * it happened to catch on a runner slower than the author's machine.
 *
 * Keyed by SESSION, unlike `finish-turn`, which is process-wide and sticky.
 * These barriers are released one at a time and often several times per test, so
 * a global lever would let one spec advance a neighbour's scenario — and the
 * test-mode server is shared by four concurrent Playwright projects.
 *
 * `released: false` (still 200) when no scenario was parked. That is a race a
 * test can legitimately lose — the scenario may not have reached the barrier yet
 * — so it is reported rather than raised, and callers poll.
 */
testControlRouter.post('/step', (req, res) => {
  const result = stepSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  res.json({ ok: true, released: interactionGate.step(result.data.sessionId) });
});

/** The session a held-process control acts on. */
const heldProcessSchema = z.object({
  sessionId: z.string().uuid(),
  enabled: z.boolean(),
});

/**
 * Resolve the runtime that owns `sessionId`, and refuse unless it is a
 * TestModeRuntime — the one adapter whose held process these controls speak for.
 *
 * All three held-process routes go through here, so the opt-in, the read and the
 * reap can never disagree about which runtime they are talking to. Without the
 * check, `POST /persistent` would happily write an opt-in for a session bound to
 * a runtime that reads a different switch entirely (this server registers a
 * claude-code-typed alias, and `?runtime=` can bind a session to `test-mode-b`),
 * and the failure would surface much later as an affordance that never appeared.
 *
 * The class is imported DYNAMICALLY, the same way `POST /reset` imports it:
 * `app.ts` imports this router statically, so a static class import here would
 * pull TestModeRuntime into the production module graph and defeat the env-var
 * gating in `index.ts`.
 *
 * @param sessionId - The session the caller named.
 * @returns The owning runtime, or the status and message to answer with.
 */
async function resolveTestModeRuntime(
  sessionId: string,
  runtimeType?: string
): Promise<{ runtime: TestModeRuntime } | { status: number; error: string }> {
  let runtime: AgentRuntime;
  try {
    runtime = runtimeType
      ? runtimeRegistry.get(runtimeType)
      : await runtimeRegistry.resolveForSession(sessionId);
  } catch (err) {
    return {
      status: 500,
      error: err instanceof Error ? err.message : 'could not resolve the session runtime',
    };
  }
  const { TestModeRuntime } = await import('../services/runtimes/test-mode/test-mode-runtime.js');
  if (!(runtime instanceof TestModeRuntime)) {
    return {
      status: 400,
      error:
        `Session ${sessionId} is bound to '${runtime.type}', which is not a test-mode runtime. ` +
        `The held-process controls only speak for test-mode's scripted process; a real runtime's ` +
        `persistent session is the operator's own setting.`,
    };
  }
  return { runtime };
}

/**
 * `POST /api/test/persistent` — put ONE session on the held-process path, or
 * take it off (DOR-1326).
 *
 * The test-mode equivalent of `runtimes.claudeCode.persistentSession` being on
 * for a chat, and the lever that makes the persistent path reachable from a
 * browser at all. Per SESSION on purpose, which the config setting is not: a
 * browser test needs both paths alive in one server. With it on, the session's next turn boots a
 * scripted process and keeps it: `getSessionWarmth` climbs to `warm`,
 * `canSteerSession` and `canStageSession` answer `true` for THAT session, a
 * steer joins its live turn, and a stage appends to it. With it off — the
 * default for every session — the same runtime answers `false` and the server
 * degrades exactly as it does for a default claude-code install.
 *
 * **Keyed by SESSION, and that is not a convenience.** The test-mode server is
 * shared by four concurrent Playwright projects, so a process-wide switch would
 * warm sessions belonging to specs that never asked for it — the same reason
 * `POST /api/test/step` is session-keyed while `finish-turn` is deliberately not.
 *
 * Turning it OFF does not cool a session that is already holding a process,
 * mirroring claude-code (ADR `260812-134510`). `POST /api/test/reap` is how a
 * process is given back.
 *
 * Refuses a session bound to a runtime that is not test-mode, rather than
 * writing an opt-in nothing will ever read: this server registers a
 * claude-code-typed alias and could register more, and a silent no-op here would
 * surface as a spec whose Steer row never appears, with nothing to point at.
 */
testControlRouter.post('/persistent', async (req, res) => {
  const result = heldProcessSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  const { sessionId, enabled } = result.data;
  const runtime = await resolveTestModeRuntime(sessionId);
  if ('error' in runtime) return res.status(runtime.status).json({ error: runtime.error });
  heldProcesses.setEnabled(sessionId, enabled);
  res.json({ ok: true, sessionId, enabled });
});

/** The session a held-process read reports on. */
const heldProcessQuerySchema = z.object({ sessionId: z.string().uuid() });

/**
 * `GET /api/test/persistent?sessionId=…` — what the RUNTIME says about this
 * session's process right now.
 *
 * Every field is read off the `AgentRuntime` seams themselves rather than out of
 * the bookkeeping behind them, which is what makes a browser assertion on
 * warmth a check of `getSessionWarmth` rather than of a number this route kept.
 * There is no product API that reports warmth — it is invisible to the person by
 * design, which is exactly why a test needs a seam of its own to see it.
 */
testControlRouter.get('/persistent', async (req, res) => {
  const result = heldProcessQuerySchema.safeParse(req.query);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  const { sessionId } = result.data;
  const resolved = await resolveTestModeRuntime(sessionId);
  if ('error' in resolved) return res.status(resolved.status).json({ error: resolved.error });
  const { runtime } = resolved;
  res.json({
    enabled: heldProcesses.isEnabled(sessionId),
    warmth: runtime.getSessionWarmth?.(sessionId) ?? 'cold',
    steerable: runtime.canSteerSession?.(sessionId) ?? runtime.getCapabilities().supportsSteer,
    stageable:
      runtime.canStageSession?.(sessionId) ?? runtime.getCapabilities().supportsContextStaging,
  });
});

/**
 * `POST /api/test/reap` — give this session's held process back.
 *
 * The scripted stand-in for the five-minute idle reap and the warm-slot
 * eviction, neither of which a browser test can wait out or provoke. It goes
 * through the runtime's own `reapSession`, so what a test observes afterwards —
 * `cold` warmth, and a next turn that answers exactly as the last one did — is
 * the contract C5 states rather than this route's own bookkeeping.
 */
testControlRouter.post('/reap', async (req, res) => {
  const result = heldProcessQuerySchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  const { sessionId } = result.data;
  const resolved = await resolveTestModeRuntime(sessionId);
  if ('error' in resolved) return res.status(resolved.status).json({ error: resolved.error });
  await resolved.runtime.reapSession?.(sessionId);
  res.json({ ok: true });
});

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
 * the trigger is scripted. Gated the same way the rest of this router is:
 * mounted only under `DORKOS_TEST_RUNTIME`, absent in production.
 */
testControlRouter.post('/room-worktree-commit', (req, res) => {
  void (async () => {
    if (!env.DORKOS_TEST_RUNTIME) return res.status(404).json({ error: 'Test runtime required.' });
    const result = roomWorktreeCommitSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }
    const { roomId, agentPath, text, message } = result.data;
    const worktrees = tryGetRoomWorktreeManager();
    if (!worktrees) return res.status(409).json({ error: 'Room repos are not wired here' });
    try {
      const agentName = getRoomAuthors().agentNameOf(agentPath);
      if (agentName === null) {
        return res.status(404).json({ error: `No agent is registered at ${agentPath}` });
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
        return res.status(400).json({ error: 'Test file must be inside the agent worktree.' });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, 'utf-8');
      const commit = await commitTestAgentWorktree(handle.path, agentName, message);
      res.json({ ok: true, commit, worktree: handle.path, slug: handle.slug });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

/** What `POST /api/test/agent-token` needs to name the agent it speaks for. */
const agentTokenSchema = z.object({
  agentPath: z.string().min(1),
});

/**
 * `POST /api/test/agent-token` — mint an identity token for an agent that is
 * really registered here, and hand it to the test.
 *
 * **Why this seam has to exist.** An agent proves who it is with
 * `X-DorkOS-Agent`, and the only place a token is ever issued in production is
 * `resolveAgentTokenEnv`, which puts it in a spawned session's **process env**
 * (spec `agent-trust` §3.1) — deliberately somewhere no model and no transcript
 * can read it. A browser test has no spawned process to read it out of, so
 * without this route there is no way for a Playwright spec to act as an agent
 * at all.
 *
 * **And a wrong token does not fail — it degrades.**
 * `resolveAgentIdentityFromHeaders` never rejects a request, so a made-up
 * header falls through to the operator and the write lands under the PERSON's
 * author id. A reaction test that fabricated a token would therefore pass while
 * proving the opposite of its name. That is the trap this closes: a real token,
 * or no test.
 *
 * **The registry check is this route's own, because `mint` has none.**
 * `AgentIdentityService.mint` stores whatever `agentPath` it is handed without
 * looking it up, and `resolveCaller` downstream mints an author row for whatever
 * path the token carries — so an unchecked seam here is a forgery seam, and a
 * 404 message describing a registration check would have been describing
 * something that never ran. `meshCore.getByPath` is the same gate the two
 * production runtimes put in front of `resolveAgentTokenEnv`
 * (`launch-resolver.ts`, `codex-runtime.ts`), so this refuses exactly what a
 * real spawn refuses.
 *
 * The display name comes from the manifest for the same reason it does there —
 * a caller-supplied one would let a real agent's token carry a name nobody gave
 * it — and it is the manifest's `displayName`, falling back to the slug only
 * when the agent has none. The token's label is what a room message an agent
 * writes is attributed with, so minting under the slug renames the agent
 * (DOR-1264).
 *
 * Gated the same way the rest of this router is: mounted only under
 * `DORKOS_TEST_RUNTIME`, absent in production.
 */
testControlRouter.post('/agent-token', async (req, res) => {
  const result = agentTokenSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  const { agentPath } = result.data;

  const meshCore = req.app.locals.meshCore as
    | {
        getByPath(projectPath: string): { name: string; displayName?: string } | undefined;
      }
    | undefined;
  const agent = meshCore?.getByPath(agentPath);
  if (!agent) {
    return res.status(404).json({
      error:
        `No agent is registered at ${agentPath}, so no identity can be minted for it. ` +
        `Register it first — a token for an unregistered path would be a forgery, ` +
        `not a test fixture.`,
    });
  }

  const service = getAgentIdentityService();
  if (!service) {
    return res
      .status(503)
      .json({ error: 'The agent identity service is not running on this server.' });
  }

  const token = await service.mint({
    agentPath,
    displayName: agent.displayName ?? agent.name,
  });
  res.json({ token });
});

/** What `POST /api/test/seed-approval` needs to raise one request card. */
const seedApprovalSchema = z.object({
  /** A real capability id, so the card's title and tier come from the registry. */
  capabilityId: z.string().min(1),
  /** The registered agent the card says asked. */
  agentPath: z.string().min(1),
  /** The permission area the request is in. A floor area draws the floor card. */
  area: z.enum(PERMISSION_AREA_IDS),
  /** The sentence the card shows. */
  summary: z.string().min(1).max(500),
});

/**
 * `POST /api/test/seed-approval` — raise a request card for an action no agent
 * can reach yet in this phase, such as one in a floor area (spec
 * `agent-permissions` phase 2 verification). It records the approval exactly
 * as the gate's `ask()` would, through the real approval service, so the card a
 * test answers is the production card. The agent must be registered here, for
 * the reason `/agent-token` gives.
 */
testControlRouter.post('/seed-approval', async (req, res) => {
  const parsed = seedApprovalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  const { capabilityId, agentPath, area, summary } = parsed.data;
  const meshCore = req.app.locals.meshCore as
    | { getByPath(projectPath: string): { name: string; displayName?: string } | undefined }
    | undefined;
  const agent = meshCore?.getByPath(agentPath);
  if (!agent) {
    return res.status(404).json({ error: `No agent is registered at ${agentPath}.` });
  }
  const approvals = req.app.locals.approvalService as ApprovalService | undefined;
  if (!approvals) {
    return res.status(503).json({ error: 'The approval service is not running on this server.' });
  }
  const ticket = approvals.request({
    capabilityId,
    inputHash: hashApprovalInput({ seeded: summary }),
    summary,
    requestedBy: agent.displayName ?? agent.name,
    requestedByPath: agentPath,
    area,
  });
  res.json({ approvalId: ticket.approvalId });
});

testControlRouter.post('/reset', async (_req, res) => {
  scenarioStore.reset();
  // Codes, DCR clients, and tokens the mock OAuth server minted. Without this a
  // bearer issued by one spec stays valid for the next, and "this server needs a
  // sign-in" passes or fails depending on what ran before it.
  resetMockMcpOAuthState();
  // Dynamic import keeps TestModeRuntime out of production module graphs:
  // app.ts mounts this router conditionally but imports it statically, so a
  // static class import here would defeat the index.ts env-var gating. The
  // try/catch shapes an import failure into this route's own 500 with the real
  // message. It is not what keeps the request from hanging: Express 5 forwards a
  // rejected handler promise to the error handler on its own (Express 4, which
  // this comment used to name, did not — there the catch was load-bearing).
  try {
    const { TestModeRuntime } = await import('../services/runtimes/test-mode/test-mode-runtime.js');
    // Reset EVERY test-mode instance, not just the default 'test-mode' type —
    // a DORKOS_TEST_RUNTIME_SECONDARY server registers a second instance
    // ('test-mode-b') whose tracked sessions would otherwise leak across
    // tests. This router is only mounted when DORKOS_TEST_RUNTIME=true, so at
    // least one instance is always registered.
    for (const runtime of runtimeRegistry.listRuntimes()) {
      if (runtime instanceof TestModeRuntime) runtime.resetTrackedSessions();
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Reset failed' });
  }
  res.json({ ok: true });
});

/**
 * The local no-op "sign-in" page the test-mode connector provider's authorize
 * URLs point at (`services/connectors/providers/test-mode.ts`). A real vendor
 * consent screen is exactly what the e2e must NOT depend on, but the browser
 * still clicks a real link that opens a real tab — this page is where it lands.
 * Connect flows in test mode succeed on poll regardless; nothing here records
 * anything.
 */
testControlRouter.get('/connect-approved', (_req, res) => {
  res
    .type('html')
    .send(
      '<!doctype html><html><head><title>Signed in</title></head>' +
        '<body><main><h1>Signed in</h1><p>You can close this tab and go back to DorkOS.</p></main></body></html>'
    );
});
installTestAgentSeedRoutes(testControlRouter);

/** Fixture directory for the OAuth-MCP test agent — distinct from `seed-agent`'s. */
function e2eOAuthAgentDir(): string {
  return path.join(getBoundary(), 'tmp', 'dorkos-e2e-oauth-agent');
}

/**
 * Seed an agent whose manifest has one enabled OAuth-protected managed MCP
 * server ("granola") pointing at the in-process mock (`mock-mcp-oauth-server.ts`),
 * and register it into the mesh so `mcp.*` verbs resolve its id. Returns
 * `{ agentDir, serverUrl }` so the e2e can drive the sign-in flow (DOR-952).
 *
 * The manifest declares `runtime: 'claude-code'` — the only enum values are
 * claude-code/codex/opencode, and the test-mode server registers a claude-code
 * TestModeRuntime alias (`DORKOS_TEST_RUNTIME_CLAUDE_ALIAS`) so
 * `GET /api/mcp-config?runtime=claude-code` resolves a real `getMcpStatus`.
 * That alias is why THIS agent's sessions bind to `claude-code` while the
 * shared fixture agent's bind to the server default — see
 * {@link FIXTURE_AGENT_RUNTIME}, which must never name the aliased type.
 *
 * The server URL names whatever loopback host the server actually bound
 * (`localDialHost(env.DORKOS_HOST)` — `localhost` resolves to `::1` on macOS,
 * where an explicit `127.0.0.1` is refused), matching the OAuth callback's own
 * origin so DorkOS's in-process OAuth client and the mock agree on one host.
 */
testControlRouter.post('/seed-oauth-mcp-agent', async (req, res) => {
  const port = req.socket.localPort;
  if (!port) {
    return res.status(500).json({ error: 'could not resolve the listen port' });
  }
  // Dial the server on the SAME host it bound (via `localDialHost`), not a
  // hardcoded `127.0.0.1`: `DORKOS_HOST=localhost` resolves to `::1` on macOS,
  // where an explicit IPv4 literal is refused. This is the host DorkOS's own
  // in-process OAuth client and the operator's browser both reach the mock on.
  const serverUrl = `http://${localDialHost(env.DORKOS_HOST)}:${port}${MOCK_MCP_OAUTH_MCP_PATH}`;
  const connection: McpServerTransport = {
    transport: 'http',
    url: serverUrl,
    headers: {},
    authKind: 'oauth2',
  };
  const oauthAgentId = ulid();
  const manifest: AgentManifest = {
    id: oauthAgentId,
    name: 'E2E OAuth MCP Agent',
    description: 'Seeded by test setup — one OAuth-protected managed MCP server',
    runtime: 'claude-code',
    capabilities: [],
    // Same reason as the fixture above (DOR-949).
    ...seedAgentFace(oauthAgentId),
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-e2e',
    personaEnabled: false,
    isSystem: false,
    mcpServers: [
      {
        name: 'granola',
        enabled: true,
        connection,
        addedAt: new Date().toISOString(),
        addedBy: 'operator',
      },
    ],
    workspace: { mode: 'home' },
  };
  const agentDir = e2eOAuthAgentDir();
  await writeManifest(agentDir, manifest);
  // Register into the mesh cache so `mcp.list`/`mcp.signin` resolve the agent id
  // to this path (ADR-0043 file-first write-through), mirroring seed-bridge.
  const meshCore = req.app.locals.meshCore as
    { syncFromDisk(path: string): Promise<unknown> } | undefined;
  if (meshCore) await meshCore.syncFromDisk(agentDir);
  res.json({ ok: true, agentDir, serverUrl });
});

const probeSchema = z.object({
  /** The seeded agent's directory, from `POST /api/test/seed-oauth-mcp-agent`. */
  agentPath: z.string().min(1),
  /** The managed server's name to probe. */
  name: z.string().min(1),
});

/**
 * Probe a managed MCP server through its INJECTED connection — the exact
 * connection (bearer header and all) the injection path hands a runtime — and
 * report whether it is reachable and how many tools it lists. This is what makes
 * the mock's bearer gate load-bearing in the e2e: before sign-in the injected
 * connection carries no bearer, so the mock answers 401 → `needsAuth`; after
 * sign-in the injected bearer unlocks `tools/list`, proving the token was stored
 * and injected (DOR-952).
 *
 * The MCP client + probe transport are dynamically imported so this test-only
 * seam adds nothing to the production module graph (the /reset pattern).
 */
testControlRouter.post('/probe-mcp-oauth-server', async (req, res) => {
  const parsed = probeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  const service = req.app.locals.agentMcpServerService as AgentMcpServerService | undefined;
  if (!service) {
    return res.status(500).json({ error: 'agentMcpServerService unavailable' });
  }
  // Resolve the path the SAME way `GET /api/mcp-config` does (realpath-canonical),
  // so the probe reads the identical cwd key the injection resolver caches under.
  const agentPath = await validateBoundary(parsed.data.agentPath);
  const servers = service.injectableServersForCwd(agentPath);
  const injected = servers[parsed.data.name];
  if (!injected) {
    return res.json({
      ok: false,
      error: 'server is not injectable (no manifest, or disabled)',
      agentPath,
      available: Object.keys(servers),
    });
  }

  const [{ Client }, probe] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('../services/mesh/agent-mcp-probe.js'),
  ]);
  const client = new Client(
    { name: 'dorkos-e2e-oauth-probe', version: '1.0.0' },
    { capabilities: {} }
  );
  // The injected connection is the runtime-neutral McpAppServerConnection shape,
  // a structural subset of McpServerTransport (it drops the on-disk `authKind`
  // hint the probe transport never reads) — safe for createProbeTransport.
  const transport = probe.createProbeTransport(injected as McpServerTransport);
  try {
    const tools = await probe.withProbeTimeout(
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      probe.TEST_PROBE_TIMEOUT_MS
    );
    return res.json({ ok: true, toolCount: tools.tools.length });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return res.json(
      probe.isUnauthorizedProbeError(err)
        ? { ok: false, needsAuth: true, error }
        : { ok: false, error }
    );
  } finally {
    await client.close().catch(() => {});
  }
});

const connectorRuntimeRequestProbeSchema = z
  .object({
    sessionId: z.string().uuid(),
    agentPath: z.string().min(1),
    request: ConnectorAgentConnectionRequestInputSchema,
  })
  .strict();

const connectorRuntimeExecutionProbeSchema = z
  .object({
    sessionId: z.string().uuid(),
    agentPath: z.string().min(1),
    target: ConnectorExecutionTargetSchema,
  })
  .strict();

/**
 * Hold one real `connectors.request_connection` call through the authenticated
 * internal listener so a browser can exercise the owner decision while the
 * originating agent call is still live. The route exists only under
 * `DORKOS_TEST_RUNTIME`; production code supplies the probe after the listener
 * starts and still resolves the session, Mesh agent, principal, and request.
 */
testControlRouter.post('/connectors/request', async (req, res) => {
  const parsed = connectorRuntimeRequestProbeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  const probe = req.app.locals.connectorRuntimeRequestProbe as
    ConnectorRuntimeRequestProbe | undefined;
  if (!probe) return res.status(503).json({ error: 'Service request probe is unavailable.' });

  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortClosedResponse = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', abort);
  res.once('close', abortClosedResponse);
  try {
    const agentPath = await validateBoundary(parsed.data.agentPath);
    res.json(
      await probe({
        sessionId: parsed.data.sessionId,
        agentPath,
        request: parsed.data.request,
        signal: controller.signal,
      })
    );
  } catch (error) {
    if (controller.signal.aborted) return;
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : 'Request probe failed.' });
  } finally {
    req.off('aborted', abort);
    res.off('close', abortClosedResponse);
  }
});

/** Execute one granted read operation through the authenticated internal connector listener. */
testControlRouter.post('/connectors/execute-read', async (req, res) => {
  const parsed = connectorRuntimeExecutionProbeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
  }
  const probe = req.app.locals.connectorRuntimeExecutionProbe as
    ConnectorRuntimeExecutionProbe | undefined;
  if (!probe) return res.status(503).json({ error: 'Service access probe is unavailable.' });

  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortClosedResponse = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', abort);
  res.once('close', abortClosedResponse);
  try {
    const agentPath = await validateBoundary(parsed.data.agentPath);
    res.json(
      await probe({
        sessionId: parsed.data.sessionId,
        agentPath,
        target: parsed.data.target,
        signal: controller.signal,
      })
    );
  } catch (error) {
    if (controller.signal.aborted) return;
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : 'Service access probe failed.' });
  } finally {
    req.off('aborted', abort);
    res.off('close', abortClosedResponse);
  }
});
