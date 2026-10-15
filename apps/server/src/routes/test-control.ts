import { configureLocalBrowserDriving } from '../services/runtimes/test-mode/local-browser-driving-scenario.js';
import type { LocalBrowserService } from '../services/session/local-browser/service.js';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono, type Context } from 'hono';
import path from 'path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import { seedAgentFace } from '@dorkos/shared/agent-face';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { TestModeRuntime } from '../services/runtimes/test-mode/test-mode-runtime.js';
import {
  ConnectorAgentConnectionRequestInputSchema,
  ConnectorExecutionTargetSchema,
  type ConnectorAgentConnectionRequestInput,
  type ConnectorExecutionTarget,
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
import {
  getRoomService,
  getBridgeStore,
  getRoomAuthors,
  resolveOperatorAuthor,
  tryGetRoomWorktreeManager,
} from '../services/rooms/index.js';
import { commitAll } from '../services/rooms/repo/room-repo-git.js';
import { getAgentIdentityService } from '../services/core/agent-identity/agent-identity-service.js';
import { hashApprovalInput, type ApprovalService } from '../services/core/approvals/index.js';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';
import { MOCK_MCP_OAUTH_MCP_PATH, resetMockMcpOAuthState } from './mock-mcp-oauth-server.js';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import { getRemoteConnectionStore } from '../services/communities/remote/state.js';
import type { AgentMcpServerService } from '../services/mesh/agent-mcp-server-service.js';
import type { SyncFromDiskResult } from '@dorkos/mesh';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { validationFailureBody } from '../lib/route-utils.js';

/** The slice of the agent registry the seeding routes use. */
export interface TestControlMesh {
  /** The registered agent at a project directory, if any. */
  getByPath(projectPath: string): { name: string; displayName?: string } | undefined;
  /** Register (or refresh) the agent whose manifest is at `projectPath`. */
  syncFromDisk(projectPath: string): Promise<SyncFromDiskResult>;
}

/**
 * What the test-control routes read from the running server, each read per
 * request: a server may compose a part after the routes are built, and one it
 * never composes answers its route's own "unavailable" refusal.
 */
export interface TestControlDeps {
  /** The same live browser service handed to the human routes and runtime tools. */
  localBrowser?: () => LocalBrowserService | undefined;
  /** The agent registry. */
  meshCore?: () => TestControlMesh | undefined;
  /** The request cards. */
  approvals?: () => ApprovalService | undefined;
  /** The agents' managed MCP servers. */
  agentMcpServers?: () => AgentMcpServerService | undefined;
  /** The connection-request bridge into the internal connector listener. */
  connectorRequestProbe?: () => ConnectorRuntimeRequestProbe | undefined;
  /** The read bridge into the internal connector listener. */
  connectorExecutionProbe?: () => ConnectorRuntimeExecutionProbe | undefined;
}

/** Groups other test-only modules hang under `/api/test`, mounted with the routes. */
const extraGroups: Array<{ path: string; routes: Hono<ApiEnv> }> = [];

/**
 * Hang a test-only group under `/api/test`, as the test-mode Cloud does with
 * its approval page and inference stream. Add it before the server composes
 * its routes (`http/hono-api.ts`): a group added later is not served.
 *
 * @param path - Its path under `/api/test`, e.g. `/fake-cloud`.
 * @param routes - Its routes.
 */
export function addTestControlGroup(path: string, routes: Hono<ApiEnv>): void {
  extraGroups.push({ path, routes });
}

let remoteCommunitySubscriptionProbe: ((ref: string, roomId: string) => unknown) | undefined;

/** Bind the private replay barrier after the room subsystem completes startup. */
export function setRemoteCommunitySubscriptionProbe(
  next: ((ref: string, roomId: string) => unknown) | undefined
): void {
  remoteCommunitySubscriptionProbe = next;
}

/** Test-only bridge into the authenticated internal connector MCP listener. */
export interface ConnectorRuntimeRequestProbe {
  /** Open one real runtime principal, call the request tool, and close the turn. */
  (input: {
    readonly sessionId: string;
    readonly agentPath: string;
    readonly request: ConnectorAgentConnectionRequestInput;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

/** Test-only bridge for one authenticated runtime read through the internal connector listener. */
export interface ConnectorRuntimeExecutionProbe {
  /** Open one real runtime principal, call the read tool, and close the turn. */
  (input: {
    readonly sessionId: string;
    readonly agentPath: string;
    readonly target: ConnectorExecutionTarget;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

const remoteCommunitySubscriptionQuerySchema = z
  .object({ ref: z.string().min(1), roomId: z.string().min(1) })
  .strict();

/**
 * Run a connector probe for as long as its caller waits, and answer with what
 * it returned. A caller that leaves aborts the probe, and gets no answer.
 *
 * @param c - The request.
 * @param failure - The message for a probe that failed without a message.
 * @param run - The probe, handed the signal that says the caller left.
 */
async function holdWhileTheCallerWaits(
  c: Context<ApiEnv>,
  failure: string,
  run: (signal: AbortSignal) => Promise<unknown>
): Promise<Response> {
  const { incoming, outgoing } = c.env;
  const controller = new AbortController();
  const abort = () => controller.abort();
  // Nothing is written to the response until the probe answers, so a close
  // before then is the caller leaving.
  const abortClosedResponse = () => {
    if (!outgoing.writableEnded) controller.abort();
  };
  incoming.once('aborted', abort);
  outgoing.once('close', abortClosedResponse);
  try {
    return c.json(await run(controller.signal));
  } catch (error) {
    if (controller.signal.aborted)
      return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
    return c.json({ error: error instanceof Error ? error.message : failure }, 500);
  } finally {
    incoming.off('aborted', abort);
    outgoing.off('close', abortClosedResponse);
  }
}

/**
 * Control routes for TestModeRuntime. Only mounted when DORKOS_TEST_RUNTIME=true
 * (`http/hono-api.ts`), so every `/api/test/*` path is the `/api` 404 in
 * production.
 *
 * @param deps - What the routes read from the running server.
 */
export function createTestControlRoutes(deps: TestControlDeps = {}): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  configureLocalBrowserDriving(() => deps.localBrowser?.());

  /** Test-only owner-qualified replay barrier. Production never mounts these routes. */
  router.get('/community-subscription', (c) => {
    const parsed = remoteCommunitySubscriptionQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) return c.json({ error: 'A community ref and roomId are required.' }, 400);
    if (!remoteCommunitySubscriptionProbe)
      return c.json({ error: 'Community subscription probe is unavailable.' }, 503);
    const value = remoteCommunitySubscriptionProbe(parsed.data.ref, parsed.data.roomId);
    if (!value) return c.json({ error: 'Community room subscription is unavailable.' }, 404);
    return c.json(value);
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
  router.post('/community-connection-change', async (c) => {
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
    return c.json({ ok: true });
  });

  const scenarioSchema = z.object({
    name: z.string().min(1),
    sessionId: z.string().uuid().optional(),
  });

  router.post('/scenario', (c) => {
    const result = scenarioSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { name, sessionId } = result.data;
    try {
      if (sessionId) {
        scenarioStore.setForSession(sessionId, name);
      } else {
        scenarioStore.setDefault(name);
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 400);
    }
    return c.json({ ok: true, scenario: name });
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
  router.post('/canonical-id', async (c) => {
    const result = canonicalIdSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { sessionId, canonicalId, runtime } = result.data;
    // A draft is not bound yet; declare on the runtime its first send will choose.
    const resolved = await resolveTestModeRuntime(sessionId, runtime);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    resolved.runtime.declareCanonicalSessionId(sessionId, canonicalId);
    return c.json({ ok: true, sessionId, canonicalId });
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
  router.post('/finish-turn', (c) => {
    requestFinishTurn();
    return c.json({ ok: true });
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
  router.post('/interrupt-outcome', (c) => {
    const result = interruptOutcomeSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    declareInterruptOutcome(result.data.outcome ?? undefined);
    return c.json({ ok: true, outcome: result.data.outcome });
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
  router.post('/step', (c) => {
    const result = stepSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    return c.json({ ok: true, released: interactionGate.step(result.data.sessionId) });
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
   * `http/hono-api.ts` imports these routes statically, so a static class import
   * here would pull TestModeRuntime into the production module graph and defeat
   * the env-var gating there.
   *
   * @param sessionId - The session the caller named.
   * @returns The owning runtime, or the status and message to answer with.
   */
  async function resolveTestModeRuntime(
    sessionId: string,
    runtimeType?: string
  ): Promise<{ runtime: TestModeRuntime } | { status: 400 | 500; error: string }> {
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
  router.post('/persistent', async (c) => {
    const result = heldProcessSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { sessionId, enabled } = result.data;
    const runtime = await resolveTestModeRuntime(sessionId);
    if ('error' in runtime) return c.json({ error: runtime.error }, runtime.status);
    heldProcesses.setEnabled(sessionId, enabled);
    return c.json({ ok: true, sessionId, enabled });
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
  router.get('/persistent', async (c) => {
    const result = heldProcessQuerySchema.safeParse(readQuery(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { sessionId } = result.data;
    const resolved = await resolveTestModeRuntime(sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { runtime } = resolved;
    return c.json({
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
  router.post('/reap', async (c) => {
    const result = heldProcessQuerySchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { sessionId } = result.data;
    const resolved = await resolveTestModeRuntime(sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    await resolved.runtime.reapSession?.(sessionId);
    return c.json({ ok: true });
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
      const handle = await worktrees.ensureWorktree(roomId, agentPath, agentName);
      const target = path.join(handle.path, result.data.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, 'utf-8');
      // The room's home directory, which every git call in this domain uses as
      // the ceiling a repository search may not climb past. Derived rather than
      // asked for: a working copy is always `<home>/worktrees/<slug>`, and the
      // store that knows the path is the manager's own.
      const ceiling = path.resolve(handle.path, '..', '..');
      const commit = await commitAll(
        handle.path,
        message,
        { name: agentName, email: `${agentName}@dorkos.local` },
        ceiling
      );
      return c.json({ ok: true, commit, worktree: handle.path, slug: handle.slug });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
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
   * Gated the same way the rest of these routes are: mounted only under
   * `DORKOS_TEST_RUNTIME`, absent in production.
   */
  router.post('/agent-token', async (c) => {
    const result = agentTokenSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    const { agentPath } = result.data;

    const agent = deps.meshCore?.()?.getByPath(agentPath);
    if (!agent) {
      return c.json(
        {
          error:
            `No agent is registered at ${agentPath}, so no identity can be minted for it. ` +
            `Register it first — a token for an unregistered path would be a forgery, ` +
            `not a test fixture.`,
        },
        404
      );
    }

    const service = getAgentIdentityService();
    if (!service) {
      return c.json({ error: 'The agent identity service is not running on this server.' }, 503);
    }

    const token = await service.mint({
      agentPath,
      displayName: agent.displayName ?? agent.name,
    });
    return c.json({ token });
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
  router.post('/seed-approval', async (c) => {
    const parsed = seedApprovalSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(validationFailureBody(parsed.error), 400);
    }
    const { capabilityId, agentPath, area, summary } = parsed.data;
    const agent = deps.meshCore?.()?.getByPath(agentPath);
    if (!agent) {
      return c.json({ error: `No agent is registered at ${agentPath}.` }, 404);
    }
    const approvals = deps.approvals?.();
    if (!approvals) {
      return c.json({ error: 'The approval service is not running on this server.' }, 503);
    }
    const ticket = approvals.request({
      capabilityId,
      inputHash: hashApprovalInput({ seeded: summary }),
      summary,
      requestedBy: agent.displayName ?? agent.name,
      requestedByPath: agentPath,
      area,
    });
    return c.json({ approvalId: ticket.approvalId });
  });

  router.post('/reset', async (c) => {
    scenarioStore.reset();
    // Codes, DCR clients, and tokens the mock OAuth server minted. Without this a
    // bearer issued by one spec stays valid for the next, and "this server needs a
    // sign-in" passes or fails depending on what ran before it.
    resetMockMcpOAuthState();
    // Dynamic import keeps TestModeRuntime out of production module graphs:
    // `http/hono-api.ts` mounts these routes conditionally but imports them
    // statically, so a static class import here would defeat the env-var gating.
    // The try/catch shapes an import failure into this route's own 500 with the
    // real message, rather than the chain's generic one.
    try {
      const { TestModeRuntime } =
        await import('../services/runtimes/test-mode/test-mode-runtime.js');
      // Reset EVERY test-mode instance, not just the default 'test-mode' type —
      // a DORKOS_TEST_RUNTIME_SECONDARY server registers a second instance
      // ('test-mode-b') whose tracked sessions would otherwise leak across
      // tests. This router is only mounted when DORKOS_TEST_RUNTIME=true, so at
      // least one instance is always registered.
      for (const runtime of runtimeRegistry.listRuntimes()) {
        if (runtime instanceof TestModeRuntime) runtime.resetTrackedSessions();
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Reset failed' }, 500);
    }
    return c.json({ ok: true });
  });

  /**
   * The local no-op "sign-in" page the test-mode connector provider's authorize
   * URLs point at (`services/connectors/providers/test-mode.ts`). A real vendor
   * consent screen is exactly what the e2e must NOT depend on, but the browser
   * still clicks a real link that opens a real tab — this page is where it lands.
   * Connect flows in test mode succeed on poll regardless; nothing here records
   * anything.
   */
  router.get('/connect-approved', (c) =>
    c.body(
      '<!doctype html><html><head><title>Signed in</title></head>' +
        '<body><main><h1>Signed in</h1><p>You can close this tab and go back to DorkOS.</p></main></body></html>',
      200,
      { 'Content-Type': 'text/html; charset=utf-8' }
    )
  );

  const seedAgentSchema = z
    .object({
      slot: z
        .enum(['shared', 'denied-access', 'permission-requester', 'suggestion-requester'])
        .default('shared'),
      /**
       * A fresh agent in the same slot: a spec whose checks read history that
       * outlives an attempt (the Always allow suggestion counts a week of
       * answers, and "Not now" is kept) seeds a new instance per attempt, so a
       * retry or a rerun on the same server starts clean. Bounded, so the
       * directory stays inside the slot's own by construction.
       */
      instance: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .optional(),
    })
    .default({ slot: 'shared' });

  /** A fixed, enum-bounded test identity slot. */
  type SeedAgentSlot = z.infer<typeof seedAgentSchema>['slot'];

  /**
   * Each slot's name and description. The requesters are agents of their own so
   * the permission specs' changes, their per-agent request limits and the
   * Always allow suggestion's count never touch DorkBot or each other.
   */
  const SEED_AGENT_COPY: Record<SeedAgentSlot, { name: string; description: string }> = {
    shared: {
      name: 'E2E Test Agent',
      description: 'Seeded by test setup — runs on the server default runtime',
    },
    'denied-access': {
      name: 'E2E Denied Agent',
      description: 'Requests access that the owner denies.',
    },
    'permission-requester': {
      name: 'E2E Permission Requester',
      description: 'Asks for permissions a person answers on the request card.',
    },
    'suggestion-requester': {
      name: 'E2E Suggestion Requester',
      description: 'Asks for the same thing until the card suggests Always allow.',
    },
  };

  /**
   * Fixture directory for a seeded test agent, derived from the RESOLVED
   * directory boundary and a closed slot enum so it is in-bounds by construction.
   *
   * It used to be spelled `os.homedir()/tmp/dorkos-e2e-agent`, which was in-bounds
   * only by coincidence: an unconfigured boundary happens to default to the home
   * directory. Under a configured `DORKOS_BOUNDARY` (the Docker deployment) that
   * seeded an agent outside the boundary, which every cockpit surface would then
   * refuse — and it reached into the operator's real home to do it, which
   * `os.homedir()` is banned in server code for (Hard Rule 3).
   *
   * `getBoundary()` returns a realpath-resolved root, so the path handed back is
   * already canonical — the same form `validateBoundary()` normalizes to before
   * it checks containment. Under an unconfigured boundary that need not be the
   * literal `~/...` string the old constant produced (a symlinked home resolves
   * through), but it names the same directory and is the more robust of the two.
   *
   * Resolved per request rather than at module load: `http/hono-api.ts` imports
   * these routes statically, which runs before `initBoundary()` does at startup.
   */
  function e2eAgentDir(slot: SeedAgentSlot = 'shared', instance?: string): string {
    const suffix = `${slot === 'shared' ? '' : `-${slot}`}${instance ? `-${instance}` : ''}`;
    return path.join(getBoundary(), 'tmp', `dorkos-e2e-agent${suffix}`);
  }

  /**
   * The fixture agent's identity, derived from its directory rather than minted.
   *
   * **Why this is not `ulid()` (DOR-1142 review).** `chat-mock.spec.ts` seeds in
   * a per-test `beforeEach`, so a fresh id per call meant a fresh identity for the
   * same directory dozens of times per run — and `AgentRegistry.upsert` handles a
   * new id at an occupied path by DELETING the incumbent row. That delete is
   * `registry.remove()`, a bare row delete, not `unregister()` — so it never
   * reaches `relayBridge.unregisterAgent`, while `upsertAutoImported` goes on to
   * register a Relay endpoint for the new id. One orphaned endpoint per seed, on
   * a leg that runs with Relay enabled. The rooms author-registry reads the same
   * churn as an occupancy change: it keys rows to `minted_for_manifest_id`, so a
   * new id at a known directory is "this directory changed hands" and the rooms
   * do not carry over.
   *
   * Nothing failed today, which is exactly why it is worth pinning: the fixture
   * was quietly exercising the relocation machinery on every test instead of
   * being the boring, stable agent it is meant to stand for.
   *
   * Keyed on the PATH rather than a bare constant so the mapping stays one-to-one
   * in both directions. A constant would follow the fixture to whatever directory
   * a changed `DORKOS_BOUNDARY` puts it in, and against a `DORK_HOME` that
   * outlived the move the old row would still hold that id at the old path —
   * which `upsert` answers with `duplicate-id`, i.e. the seed route failing for a
   * reason no diff explains. Same directory, same agent; different directory,
   * different agent.
   *
   * Shaped like a ULID (26 Crockford-base32 characters) because that is what the
   * rest of the system reads ids as, though nothing validates the format —
   * `AgentManifestSchema.id` is `z.string().min(1)`. The digest is truncated, not
   * decoded: this needs to be stable and collision-free against one other
   * fixture, not unguessable.
   *
   * @param agentDir - The fixture's directory, from {@link e2eAgentDir}.
   */
  function fixtureAgentId(agentDir: string): string {
    const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const digest = createHash('sha256').update(agentDir).digest();
    let id = '';
    for (let i = 0; i < 26; i += 1) id += CROCKFORD[digest[i] % 32];
    return id;
  }

  /**
   * The execution runtime the shared fixture agent's manifest declares.
   *
   * `AgentManifest.runtime` is required and its enum has no `test-mode` member,
   * so this fixture has to name a real harness — and a manifest runtime WINS over
   * the server default whenever this process registers it
   * (`resolveRuntimeTypeForNewSession` in
   * `services/session/launch/launch-session.ts`). Every spec that
   * starts a session in this agent's directory means "the server default"
   * (`test-mode`), so the declared value must be a runtime the test-mode server
   * never registers — then resolution soft-falls back to the default.
   *
   * It used to say `claude-code`, which held only for as long as nothing
   * registered that type here. DOR-952 registered a claude-code-typed
   * TestModeRuntime alias so the managed-MCP OAuth spec could resolve
   * `GET /api/mcp-config?runtime=claude-code`, and every seeded session silently
   * moved onto that alias: session rows started reading "Claude Code" instead of
   * "Test Mode" and the session-list runtime-mark spec failed on every run
   * (DOR-991). `codex` is a real runtime this server never registers — and the
   * guard below turns a future alias for it into a named failure instead of the
   * same silent re-pointing.
   */
  const FIXTURE_AGENT_RUNTIME = 'codex';

  /**
   * Seed a test agent in one of four fixed slots inside the directory boundary —
   * on disk AND in the mesh registry.
   *
   * Overwrites any existing manifest so tests always start with a clean agent.
   * Returns `{ agentDir, agentId }` so the test can navigate to `/?dir=<agentDir>`.
   *
   * **Registration is half the job, and it used to be missing (DOR-1142).** This
   * route wrote a manifest and stopped, which is not the same as having an agent:
   * `GET /api/sessions/recent` and `GET /api/sessions/daily-counts` both fan out
   * over `meshCore.listWithPaths()`, so a directory the mesh has never heard of
   * contributes no sessions however many it holds. Every sidebar zone that is
   * built from recent sessions — Today, Heads-up — was therefore structurally
   * empty on the test-mode leg, and three separate suites had grown their own
   * `beforeEach`/`afterEach` registration dance to work around it. Seeding an
   * agent nothing can see is a seam with a hole in it, not a fixture.
   *
   * **`syncFromDisk`, deliberately, and not `registerByPath`.** The suites'
   * workaround called `POST /api/mesh/agents`, which does more than register: it
   * used to mint a SECOND id distinct from the manifest's own and rewrite the
   * manifest it was just handed (that half is gone — since DOR-1019 it adopts a
   * manifest already on disk), and it still fires
   * `notifyAgentCreated` — whose reaction seats the agent in #team. On a server
   * the `chromium-team-room` project also drives, that is a cross-project side
   * effect nobody asked for. `syncFromDisk` is the same path `POST /api/agents`
   * uses for a manifest already written by hand: it adopts the id on disk, adds
   * exactly one registry row, and announces nothing.
   *
   * **No cleanup is owed, because little accumulates.** Each of the four slots maps
   * to one fixed directory and stable id; an `instance` adds one agent per
   * attempt, inside the leg's throwaway data directory. Re-seeding replaces that slot's row
   * rather than stacking rows. `POST /api/test/reset` does not touch mesh, and
   * does not need to.
   *
   * Refuses when {@link FIXTURE_AGENT_RUNTIME} is registered here — see there.
   */
  router.post('/seed-agent', async (c) => {
    const input = seedAgentSchema.safeParse(readJsonBody(c));
    if (!input.success) {
      return c.json(validationFailureBody(input.error), 400);
    }
    if (runtimeRegistry.has(FIXTURE_AGENT_RUNTIME)) {
      return c.json(
        {
          error:
            `seed-agent: '${FIXTURE_AGENT_RUNTIME}' is registered on this server, so sessions ` +
            `seeded from this agent would bind to it instead of the server default ` +
            `('${runtimeRegistry.getDefaultType()}'). Point FIXTURE_AGENT_RUNTIME at a runtime ` +
            `this server does not register.`,
        },
        500
      );
    }
    const { slot, instance } = input.data;
    const agentDir = e2eAgentDir(slot, instance);
    const fixtureId = fixtureAgentId(agentDir);
    const manifest: AgentManifest = {
      id: fixtureId,
      ...SEED_AGENT_COPY[slot],
      runtime: FIXTURE_AGENT_RUNTIME,
      capabilities: [],
      // A fixture agent wears a face for the same reason a real one does: no
      // production path can mint a faceless agent any more (DOR-949), so a
      // browser test staged against one would be testing a shape the app cannot
      // produce. Deterministic from the fixture's own id, like everywhere else.
      ...seedAgentFace(fixtureId),
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'dorkos-e2e',
      personaEnabled: false,
      isSystem: false,
      mcpServers: [],
      workspace: { mode: 'home' },
    };
    await writeManifest(agentDir, manifest);

    // Every refusal below is a 500 rather than a quiet `{ ok: true }`. A seed
    // route that half-worked is what this ticket was: the caller gets a
    // directory, believes it has an agent, and fails ten assertions later in a
    // spec about the sidebar. Say it here, where the cause is.
    //
    // Deliberately NOT the best-effort `try { ... } catch { /* non-fatal */ }`
    // that `POST /api/agents` wraps its own `syncFromDisk` in. There, swallowing
    // is right: the agent was really created and the DB cache reconciles itself
    // within five minutes. Here, registration IS the product of the call, so a
    // swallowed throw would hand back the same `{ ok: true }` as a working seed
    // and put the hole straight back.
    const meshCore = deps.meshCore?.();
    if (!meshCore) {
      return c.json(
        {
          error:
            'seed-agent: this server has no meshCore, so the seeded agent cannot be registered. ' +
            'Sessions in it would be invisible to GET /api/sessions/recent.',
        },
        500
      );
    }
    // The catch is what keeps a thrown registration legible. A rejected handler
    // would reach the chain's generic error handler, which answers 500 with no
    // mention of seeding — a diagnosis-free 500 in the one route whose entire job
    // is diagnosis.
    let outcome: SyncFromDiskResult;
    try {
      outcome = await meshCore.syncFromDisk(agentDir);
    } catch (err) {
      return c.json(
        {
          error:
            `seed-agent: wrote the manifest at ${agentDir} but mesh registration threw: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        },
        500
      );
    }
    if (outcome !== 'synced') {
      return c.json(
        {
          error:
            `seed-agent: wrote the manifest but the mesh refused it (${outcome}). ` +
            `'no-manifest' means \`readManifest\` answered null for ${agentDir} — the write did ` +
            `not land, or the file is unreadable, or it no longer satisfies AgentManifestSchema. ` +
            `'duplicate-id' means another directory holds id ${manifest.id}; since that id is ` +
            `derived from this path, it means a stale row survives from when the fixture lived ` +
            `elsewhere — wipe this server's DORK_HOME.`,
        },
        500
      );
    }
    return c.json({ ok: true, agentDir, agentId: manifest.id });
  });

  const seedBridgeSchema = z.object({
    /** The bound agent's directory, from `POST /api/test/seed-agent`. */
    agentPath: z.string().min(1),
  });

  /**
   * Seed a bridged **channel** — the platform faked one layer up, at the adapter
   * boundary, so there is no grammY `Bot` and no live Telegram (the same fake the
   * server-side integration suite uses). It mints the room and its `room_bridges`
   * row through the real `RoomService.createBridgedRoom`, stamps a
   * `mentions-only` visibility so the header badge renders, and writes one
   * external-author entry through the real `postExternal` so an origin mark
   * renders beside a message from outside the machine. The e2e (`tests/relay/
   * bridged-channel.spec.ts`) then drives the cockpit-observable half: see the
   * badge and the mark, post from the composer, watch the post land.
   *
   * Only reachable under `DORKOS_TEST_RUNTIME` (this whole router is), and it
   * uses a fresh chat id per call so re-runs never collide on the bridge's
   * `(adapterId, chatId)` unique index.
   */
  router.post('/seed-bridge', async (c) => {
    const result = seedBridgeSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json(validationFailureBody(result.error), 400);
    }
    try {
      // Register the seeded agent into the mesh cache so the room roster can
      // resolve it by path (ADR-0043's file-first write-through).
      //
      // Redundant for the usual caller and kept anyway. `seed-agent` registers
      // what it seeds now (DOR-1142), so a bridge seeded against that fixture is
      // already resolvable and this is a no-op re-sync — `upsert` on an unchanged
      // manifest. But `agentPath` is a free parameter: nothing makes a caller
      // pass the fixture's directory, and a spec that writes its own manifest
      // somewhere and bridges it would otherwise get a roster that cannot name
      // the agent. Costing one idempotent write to stay correct for any path is
      // the right trade for a test seam.
      await deps.meshCore?.()?.syncFromDisk(result.data.agentPath);

      const rooms = getRoomService();
      const bridges = getBridgeStore();
      // The operator is the install owner when there is one (onboarding creates
      // it), and the unbound local human otherwise — the same resolution the
      // production bridge lifecycle uses, so `createBridgedRoom`'s owner check
      // passes on a real (onboarded) server the same way it does in prod.
      const authors = getRoomAuthors();
      const operatorAuthorId = resolveOperatorAuthor(authors).id;
      const adapterId = 'tg-e2e';
      const chatId = ulid();

      const opened = rooms.createBridgedRoom({
        adapterId,
        chatId,
        bindingId: `bind-e2e-${chatId}`,
        chatType: 'group',
        channelType: 'group',
        title: 'E2E Ops Channel',
        agentPath: result.data.agentPath,
        operatorAuthorId,
      });

      // §8: the header badge reads the bridge row's visibility, sourced from the
      // platform's `getMe` in production — stamped directly here.
      bridges.setVisibility(opened.id, 'mentions-only', new Date().toISOString());

      // One message from outside the machine, so an origin mark ("· Telegram")
      // renders. `postExternal` mints the external author on the `platform:` key
      // that carries the origin (spec §4.3).
      rooms.postExternal(opened.id, {
        identity: {
          platformType: 'telegram',
          instanceId: adapterId,
          platformUserId: '145223',
          displayName: 'Miguel',
        },
        text: 'Hi from Telegram — can the team see this?',
      });

      return c.json({ ok: true, roomId: opened.id, slug: opened.slug, chatId });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'seed-bridge failed' }, 500);
    }
  });

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
  router.post('/seed-oauth-mcp-agent', async (c) => {
    const port = c.env.incoming.socket.localPort;
    if (!port) {
      return c.json({ error: 'could not resolve the listen port' }, 500);
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
    await deps.meshCore?.()?.syncFromDisk(agentDir);
    return c.json({ ok: true, agentDir, serverUrl });
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
  router.post('/probe-mcp-oauth-server', async (c) => {
    const parsed = probeSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(validationFailureBody(parsed.error), 400);
    }
    const service = deps.agentMcpServers?.();
    if (!service) {
      return c.json({ error: 'agentMcpServerService unavailable' }, 500);
    }
    // Resolve the path the SAME way `GET /api/mcp-config` does (realpath-canonical),
    // so the probe reads the identical cwd key the injection resolver caches under.
    const agentPath = await validateBoundary(parsed.data.agentPath);
    const servers = service.injectableServersForCwd(agentPath);
    const injected = servers[parsed.data.name];
    if (!injected) {
      return c.json({
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
      return c.json({ ok: true, toolCount: tools.tools.length });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return c.json(
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
  router.post('/connectors/request', async (c) => {
    const parsed = connectorRuntimeRequestProbeSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(validationFailureBody(parsed.error), 400);
    }
    const probe = deps.connectorRequestProbe?.();
    if (!probe) return c.json({ error: 'Service request probe is unavailable.' }, 503);
    const { sessionId, request } = parsed.data;
    return holdWhileTheCallerWaits(c, 'Request probe failed.', async (signal) =>
      probe({
        sessionId,
        agentPath: await validateBoundary(parsed.data.agentPath),
        request,
        signal,
      })
    );
  });

  /** Execute one granted read operation through the authenticated internal connector listener. */
  router.post('/connectors/execute-read', async (c) => {
    const parsed = connectorRuntimeExecutionProbeSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(validationFailureBody(parsed.error), 400);
    }
    const probe = deps.connectorExecutionProbe?.();
    if (!probe) return c.json({ error: 'Service access probe is unavailable.' }, 503);
    const { sessionId, target } = parsed.data;
    return holdWhileTheCallerWaits(c, 'Service access probe failed.', async (signal) =>
      probe({
        sessionId,
        agentPath: await validateBoundary(parsed.data.agentPath),
        target,
        signal,
      })
    );
  });

  for (const group of extraGroups) router.route(group.path, group.routes);
  return router;
}
