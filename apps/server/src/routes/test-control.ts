import { Router } from 'express';
import path from 'path';
import { z } from 'zod';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import { getBoundary, validateBoundary } from '../lib/boundary.js';
import { localDialHost } from '../lib/local-dial-host.js';
import { env } from '../env.js';
import { requestFinishTurn, scenarioStore } from '../services/runtimes/test-mode/scenario-store.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { getRoomService, getBridgeStore, getRoomAuthors } from '../services/rooms/index.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
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
 * The lever a browser test needs to decide WHEN a turn ends. Stop cannot do it:
 * `TestModeRuntime.interruptQuery` answers `false`, because there is no process
 * to signal. Without this a test has to pick a turn short enough to wait out,
 * and then races its own setup against it.
 */
testControlRouter.post('/finish-turn', (_req, res) => {
  requestFinishTurn();
  res.json({ ok: true });
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
  const manifest: AgentManifest = {
    id: ulid(),
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
  const agentDir = e2eAgentDir();
  await writeManifest(agentDir, manifest);

  // Both refusals below are 500s rather than a quiet `{ ok: true }`. A seed
  // route that half-worked is what this ticket was: the caller gets a
  // directory, believes it has an agent, and fails ten assertions later in a
  // spec about the sidebar. Say it here, where the cause is.
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
  const outcome = await meshCore.syncFromDisk(agentDir);
  if (outcome !== 'synced') {
    return res.status(500).json({
      error:
        `seed-agent: wrote the manifest but the mesh refused it (${outcome}). ` +
        `'no-manifest' means the write did not land at ${agentDir}; 'duplicate-id' means ` +
        `another directory holds id ${manifest.id}, which should be impossible for a ` +
        `freshly minted ULID.`,
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
    // resolve it by path (ADR-0043's file-first write-through). `seed-agent`
    // only writes the manifest to disk; the cockpit normally syncs on its own
    // navigation, which this seam does not go through.
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
