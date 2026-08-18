import { Router } from 'express';
import path from 'path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import { getBoundary, validateBoundary } from '../lib/boundary.js';
import { localDialHost } from '../lib/local-dial-host.js';
import { env } from '../env.js';
import { heldProcesses } from '../services/runtimes/test-mode/held-process.js';
import { interactionGate } from '../services/runtimes/test-mode/interaction-gate.js';
import { requestFinishTurn, scenarioStore } from '../services/runtimes/test-mode/scenario-store.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { getRoomService, getBridgeStore, getRoomAuthors } from '../services/rooms/index.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import { getAgentIdentityService } from '../services/core/agent-identity/agent-identity-service.js';
import { MOCK_MCP_OAUTH_MCP_PATH, resetMockMcpOAuthState } from './mock-mcp-oauth-server.js';
import type { AgentMcpServerService } from '../services/mesh/agent-mcp-server-service.js';

/**
 * Control routes for TestModeRuntime. Only mounted when DORKOS_TEST_RUNTIME=true.
 * Returns 404 for any /api/test/* path in production (route not registered).
 */
export const testControlRouter = Router();

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
  sessionId: string
): Promise<{ runtime: AgentRuntime } | { status: number; error: string }> {
  let runtime: AgentRuntime;
  try {
    runtime = await runtimeRegistry.resolveForSession(sessionId);
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
 * The test-mode equivalent of the operator turning "Keep agents warm between
 * messages" on for a chat, and the lever that makes the persistent path
 * reachable from a browser at all. With it on, the session's next turn boots a
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

/** What `POST /api/test/agent-token` needs to name the agent it speaks for. */
const agentTokenSchema = z.object({
  agentPath: z.string().min(1),
});

/**
 * The highest tier a token minted here may ever reach.
 *
 * **`mint` defaults to `destructive`, which is the top of the ladder** — higher
 * than the ceiling an unidentified caller gets (`DEFAULT_ANONYMOUS_TIER_CEILING`
 * in `tier-enforcement.ts`). So a test seam that took the default would hand out
 * a MORE powerful identity than presenting no identity at all, which is the
 * wrong direction for a route that exists only to let a test pretend.
 *
 * `act` is the narrowest ceiling that still covers what this seam is for: the
 * rooms verbs a test drives as an agent — `post_to_room`, `react_to_room_entry`
 * — are `act` (`room-capabilities.ts`). Anything destructive is refused, which
 * is a property worth having on a token handed out over an unauthenticated
 * local route.
 *
 * It is a deliberate divergence from production, where nothing passes a ceiling
 * yet and every real spawn is therefore `destructive`. Named here rather than
 * silently inherited so the difference is a decision somebody can read.
 */
const TEST_TOKEN_TIER_CEILING: CapabilityTier = 'act';

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
    tierCeiling: TEST_TOKEN_TIER_CEILING,
  });
  res.json({ token });
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

/**
 * Fixture directory for the seeded test agent, derived from the RESOLVED
 * directory boundary so it is in-bounds by construction.
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
 * Resolved per request rather than at module load: `app.ts` imports this router
 * statically, which runs before `initBoundary()` does at startup.
 */
function e2eAgentDir(): string {
  return path.join(getBoundary(), 'tmp', 'dorkos-e2e-agent');
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
 * (`resolveRuntimeTypeForNewSession` in `routes/sessions.ts`). Every spec that
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
 * Seed a test agent at a fixed path inside the directory boundary — on disk
 * AND in the mesh registry.
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
 * workaround called `POST /api/mesh/agents`, which does more than register:
 * it mints a SECOND id distinct from the manifest's own (hence their teardown
 * having to remember it), rewrites the manifest it was just handed, and fires
 * `notifyAgentCreated` — whose reaction seats the agent in #team. On a server
 * the `chromium-team-room` project also drives, that is a cross-project side
 * effect nobody asked for. `syncFromDisk` is the same path `POST /api/agents`
 * uses for a manifest already written by hand: it adopts the id on disk, adds
 * exactly one registry row, and announces nothing.
 *
 * **No cleanup is owed, because none accumulates.** The row is keyed to this
 * one fixed directory and `AgentRegistry.upsert` evicts a different-id row
 * sitting at the same path before inserting — so re-seeding in a per-test
 * `beforeEach` replaces the row rather than stacking rows. `POST /api/test/reset`
 * does not touch mesh, and does not need to.
 *
 * Refuses when {@link FIXTURE_AGENT_RUNTIME} is registered here — see there.
 */
testControlRouter.post('/seed-agent', async (req, res) => {
  if (runtimeRegistry.has(FIXTURE_AGENT_RUNTIME)) {
    return res.status(500).json({
      error:
        `seed-agent: '${FIXTURE_AGENT_RUNTIME}' is registered on this server, so sessions ` +
        `seeded from this agent would bind to it instead of the server default ` +
        `('${runtimeRegistry.getDefaultType()}'). Point FIXTURE_AGENT_RUNTIME at a runtime ` +
        `this server does not register.`,
    });
  }
  const agentDir = e2eAgentDir();
  const manifest: AgentManifest = {
    id: fixtureAgentId(agentDir),
    name: 'E2E Test Agent',
    description: 'Seeded by test setup — runs on the server default runtime',
    runtime: FIXTURE_AGENT_RUNTIME,
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-e2e',
    personaEnabled: false,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [],
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
  const meshCore = req.app.locals.meshCore as
    | { syncFromDisk(path: string): Promise<'synced' | 'no-manifest' | 'duplicate-id'> }
    | undefined;
  if (!meshCore) {
    return res.status(500).json({
      error:
        'seed-agent: this server has no meshCore, so the seeded agent cannot be registered. ' +
        'Sessions in it would be invisible to GET /api/sessions/recent.',
    });
  }
  // The catch is what keeps a thrown registration legible. Express 5 would
  // forward a rejected handler promise to the generic error handler on its
  // own, which answers 500 with no mention of seeding — a diagnosis-free 500
  // in the one route whose entire job is diagnosis.
  let outcome: 'synced' | 'no-manifest' | 'duplicate-id';
  try {
    outcome = await meshCore.syncFromDisk(agentDir);
  } catch (err) {
    return res.status(500).json({
      error:
        `seed-agent: wrote the manifest at ${agentDir} but mesh registration threw: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (outcome !== 'synced') {
    return res.status(500).json({
      error:
        `seed-agent: wrote the manifest but the mesh refused it (${outcome}). ` +
        `'no-manifest' means \`readManifest\` answered null for ${agentDir} — the write did ` +
        `not land, or the file is unreadable, or it no longer satisfies AgentManifestSchema. ` +
        `'duplicate-id' means another directory holds id ${manifest.id}; since that id is ` +
        `derived from this path, it means a stale row survives from when the fixture lived ` +
        `elsewhere — wipe this server's DORK_HOME.`,
    });
  }
  res.json({ ok: true, agentDir, agentId: manifest.id });
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
testControlRouter.post('/seed-bridge', async (req, res) => {
  const result = seedBridgeSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
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
    const meshCore = req.app.locals.meshCore as
      | { syncFromDisk(path: string): Promise<unknown> }
      | undefined;
    if (meshCore) await meshCore.syncFromDisk(result.data.agentPath);

    const rooms = getRoomService();
    const bridges = getBridgeStore();
    // The operator is the install owner when there is one (onboarding creates
    // it), and the unbound local human otherwise — the same resolution the
    // production bridge lifecycle uses, so `createBridgedRoom`'s owner check
    // passes on a real (onboarded) server the same way it does in prod.
    const authors = getRoomAuthors();
    const owner = readOwnerAccount();
    const operatorAuthorId = owner ? authors.bindOwner(owner.id).id : authors.localHuman().id;
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

    res.json({ ok: true, roomId: opened.id, slug: opened.slug, chatId });
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'seed-bridge failed' });
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
  const manifest: AgentManifest = {
    id: ulid(),
    name: 'E2E OAuth MCP Agent',
    description: 'Seeded by test setup — one OAuth-protected managed MCP server',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-e2e',
    personaEnabled: false,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [
      {
        name: 'granola',
        enabled: true,
        connection,
        addedAt: new Date().toISOString(),
        addedBy: 'operator',
      },
    ],
  };
  const agentDir = e2eOAuthAgentDir();
  await writeManifest(agentDir, manifest);
  // Register into the mesh cache so `mcp.list`/`mcp.signin` resolve the agent id
  // to this path (ADR-0043 file-first write-through), mirroring seed-bridge.
  const meshCore = req.app.locals.meshCore as
    | { syncFromDisk(path: string): Promise<unknown> }
    | undefined;
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
