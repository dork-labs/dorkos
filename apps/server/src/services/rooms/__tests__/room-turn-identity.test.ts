/**
 * @vitest-environment node
 *
 * A room turn acts as its agent — and as nobody else (DOR-2091, spec
 * `agent-home-desk` §3, §5.1).
 *
 * A room turn stands in its agent's HOME (invariant I4), and a room with files
 * of its own is reached through folder grants rather than by standing in it.
 * DOR-2091 was a room turn standing in its worktree, a directory that hosts no
 * registered agent, and minting no identity: with login on every room verb
 * refused as `UNIDENTIFIED_CALLER`, with login off the calls fell through to
 * the OPERATOR. At home, identity comes from the registry's exact answer.
 *
 * Driven through the real claude-code launch (`resolveLaunch`), the real
 * in-session tool server (`createDorkOsToolServer`) over an in-memory MCP client,
 * the real identity service and the real rooms capabilities.
 *
 * Seeded defects, each run red:
 *
 * - Minting from `getByPath(effectiveCwd)` without the turn's agent reddens
 *   "a turn for Ben that stands in Ana's home" — it posts as Ana.
 * - Anchoring the tools on a bare `session.cwd` again — no `?? effectiveCwd` —
 *   reddens the "re-created with no directory" row in both postures.
 * - Reading identity off a room's copy of its files (the retired room-worktree
 *   owner source) reddens "a session standing in a room's copy is nobody's".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logError: vi.fn(() => ({})),
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
// The prompt is not under test, and building it reads git in the cwd.
vi.mock('../../runtimes/claude-code/messaging/context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue({ text: '', stable: '' }),
  renderContextEntry: vi.fn(() => ''),
}));
vi.mock('../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));

/** The two install facts `callerAuthor` reads per call. */
const installState: { loginEnabled: boolean } = { loginEnabled: true };

vi.mock('../../core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/auth/index.js')>()),
  readOwnerAccount: () => null,
}));
vi.mock('../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) =>
      section === 'auth' ? { enabled: installState.loginEnabled } : undefined,
    set: () => {},
  },
}));

import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import {
  AGENT_TOKEN_ENV_VAR,
  getAgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
  resolveAgentHome,
  setAgentHomeRegistry,
} from '../../core/agent-identity/index.js';
import { resolveLaunch } from '../../runtimes/claude-code/messaging/launch-resolver.js';
import type { McpServerLaunch } from '../../runtimes/claude-code/messaging/message-sender-shared.js';
import type { AgentSession } from '../../runtimes/claude-code/agent-types.js';
import { createDorkOsToolServer } from '../../runtimes/claude-code/mcp-tools/index.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { NotifyBudget } from '../../relay/notify-budget.js';
import { roomsDomain } from '../room-capabilities.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from './room-test-harness.js';
import { clearTestHomes } from '../../core/agent-identity/__tests__/agent-home-fixture.js';

const ANA = '/agents/ana';
const BEN = '/agents/ben';
const ROOMS_DIR = '/dork/rooms';
/** Ana's copy of a room's files — never where a room turn stands. */
const ANA_WORKTREE = `${ROOMS_DIR}/01ROOMWITHFILES/worktrees/ana-1a2b3c4d`;
/** A cockpit session in a plain directory: the control for the refusals. */
const PLAIN_DIR = '/projects/scratch';

/** Which recorded owners the registry still knows; a test may unregister one. */
const registered = new Set<string>();
/** The mesh as a launch sees it: two registered agents, keyed by their folders. */
const mesh = {
  getByPath: (p: string) => (registered.has(p) ? agentRows[p] : undefined),
  getSubjectByPath: () => undefined,
  updateLastSeen: vi.fn(),
} as unknown as AgentRegistryPort;

/** The agent rows the mesh holds while an agent is registered. */
const agentRows: Record<string, unknown> = {
  [ANA]: { id: 'agent-ana', name: 'ana', displayName: 'Ana' },
  [BEN]: { id: 'agent-ben', name: 'ben', displayName: 'Ben' },
};

/** What the rooms domain reads an agent member as. */
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana' },
  [BEN]: { name: 'ben', displayName: 'Ben' },
});

/** Deps for the in-session tool server — only the rooms verbs are driven. */
function toolDeps(): McpToolDeps {
  return {
    notifyBudget: new NotifyBudget(),
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dor-2091',
    dorkHome: '/tmp/dorkos-test-home',
  };
}

describe('a room turn, standing at home', () => {
  let harness: RoomHarness;
  let registry: CapabilityRegistry;
  let roomId: string;

  beforeEach(() => {
    installState.loginEnabled = true;
    registered.clear();
    registered.add(ANA).add(BEN);
    resetAgentIdentityService();
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    initAgentIdentityService(harness.db);
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Structure', members: [], agentPaths: [ANA, BEN] },
      harness.human
    ).id;
    // The registry, read live, so a test that unregisters an agent is seen at once.
    setAgentHomeRegistry({
      isRegisteredHome: (p) => registered.has(p),
      listRegisteredHomes: () => [...registered],
      managedWorkspaceOwner: () => null,
      roomsDir: ROOMS_DIR,
    });
  });

  afterEach(() => {
    clearTestHomes();
    resetAgentIdentityService();
  });

  /**
   * Launch one claude-code turn exactly as a room dispatches it, and hand back
   * what the launch minted and what it told the tool server.
   *
   * @param cwd - Where the turn stands (the room turn's `request.cwd`).
   * @param forAgent - The agent the room turn is for, or `undefined` for a turn
   *   no room triggered.
   */
  async function launch(
    cwd: string,
    forAgent: string | undefined,
    options: { sessionHasNoCwd?: boolean } = {}
  ): Promise<{ token: string | undefined; toolLaunch: McpServerLaunch; session: AgentSession }> {
    let toolLaunch: McpServerLaunch | undefined;
    // A room session: its own cwd is where it stands. Or, with
    // `sessionHasNoCwd`, the session the store re-creates after a
    // restart when a settings PATCH reaches it first (`session-store.ts`
    // `updateSession`), which carries no directory at all.
    const session: AgentSession = {
      sdkSessionId: 'sdk-1',
      lastActivity: Date.now(),
      permissionMode: 'default',
      hasStarted: false,
      pendingInteractions: new Map(),
      eventQueue: [],
      ...(options.sessionHasNoCwd ? {} : { cwd }),
    };
    const resolved = await resolveLaunch({
      sessionId: 'room-session-1',
      content: 'what do you think?',
      session,
      opts: {
        cwd: '/tmp/dor-2091-default',
        meshCore: mesh,
        onSdkSessionRebind: async () => {},
        mcpServerFactory: (_session, _id, seen) => {
          toolLaunch = seen;
          return {};
        },
      },
      messageOpts: {
        cwd,
        ...(forAgent !== undefined
          ? { roomTurn: { roomId, authorId: 'unused', turnId: 'turn-1', cwd, agentPath: forAgent } }
          : {}),
      },
      effectiveCwd: cwd,
    });
    const env = resolved.sdkOptions.env as Record<string, string | undefined>;
    return { token: env[AGENT_TOKEN_ENV_VAR], toolLaunch: toolLaunch!, session };
  }

  /**
   * Call `post_to_room` from inside that session, through the real server.
   *
   * @returns The tool's reply: `posted` on success, or the refusal's `code`.
   */
  async function postFrom(
    session: AgentSession,
    toolLaunch: McpServerLaunch,
    text: string
  ): Promise<{ posted?: boolean; code?: string }> {
    const server = createDorkOsToolServer(
      toolDeps(),
      session,
      'room-session-1',
      undefined,
      registry,
      new Set(),
      toolLaunch.identity
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'dor-2091-probe', version: '0.0.0' });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
    const result = (await client.callTool({
      name: 'post_to_room',
      arguments: { roomId, text },
    })) as { content: Array<{ text?: string }> };
    await client.close();
    return JSON.parse(result.content[0]!.text!);
  }

  /** Who wrote the room's most recent entry. */
  function lastAuthor(): string | undefined {
    return harness.service.readHistory(roomId, harness.human, { limit: 50 }).at(-1)?.authorId;
  }

  /** Ana's author row in the room. */
  function anaAuthor(): string {
    return harness.authors.resolveAgent(ANA, 'Ana').id;
  }

  describe.each([
    ['ON', true],
    ['OFF', false],
  ])('with login %s', (_label, loginEnabled) => {
    beforeEach(() => {
      installState.loginEnabled = loginEnabled;
    });

    it("mints the agent's token for a turn standing in its home", async () => {
      const { token, toolLaunch } = await launch(ANA, ANA);

      expect(token).toBeDefined();
      const identity = await getAgentIdentityService()!.resolve(token!);
      expect(identity?.agentPath).toBe(ANA);
      expect(toolLaunch.identity).toEqual({ kind: 'home', home: ANA, via: 'exact' });
    });

    it('posts as the agent, not as nobody and not as the operator', async () => {
      const { session, toolLaunch } = await launch(ANA, ANA);

      const reply = await postFrom(session, toolLaunch, 'here is the plan');

      expect(reply.code).toBeUndefined();
      expect(reply.posted).toBe(true);
      expect(lastAuthor()).toBe(anaAuthor());
      expect(lastAuthor()).not.toBe(harness.human);
    });

    it("refuses a turn for Ben that stands in Ana's home: no token, and no post as anyone", async () => {
      const before = lastAuthor();
      const { token, session, toolLaunch } = await launch(ANA, BEN);

      expect(token).toBeUndefined();
      expect(toolLaunch.identity).toMatchObject({ kind: 'refused' });
      const reply = await postFrom(session, toolLaunch, 'posting as Ana, apparently');

      expect(reply.posted).toBeUndefined();
      expect(reply.code).toBe('AGENT_IDENTITY_UNVERIFIED');
      expect(lastAuthor()).toBe(before);
    });

    it('posts as the agent when the session was re-created with no directory', async () => {
      const { session, toolLaunch } = await launch(ANA, ANA, { sessionHasNoCwd: true });

      const reply = await postFrom(session, toolLaunch, 'still me after a restart');

      expect(reply.code).toBeUndefined();
      expect(reply.posted).toBe(true);
      expect(lastAuthor()).toBe(anaAuthor());
    });

    it('refuses a turn whose agent was unregistered — never the operator', async () => {
      registered.delete(ANA);
      const before = lastAuthor();

      const { token, session, toolLaunch } = await launch(ANA, ANA);

      expect(token).toBeUndefined();
      const reply = await postFrom(session, toolLaunch, 'whose am I now?');

      expect(lastAuthor(), 'nothing may be written, least of all as the operator').toBe(before);
      expect(reply.code).toBe('AGENT_IDENTITY_UNVERIFIED');
      expect(reply.posted).toBeUndefined();
      expect(toolLaunch.identity).toEqual({ kind: 'refused', reason: 'unregistered-owner' });
    });
  });

  it('treats a session standing in a room’s copy of its files as nobody’s (I2, after T4)', async () => {
    // A room's copy is never a desk: a person who opens a session there is in a
    // folder, not in an agent. The old room-worktree owner source would have
    // answered Ana here.
    expect(resolveAgentHome(ANA_WORKTREE)).toEqual({ kind: 'none' });
    installState.loginEnabled = true;
    const { token, toolLaunch } = await launch(ANA_WORKTREE, undefined);

    expect(token).toBeUndefined();
    expect(toolLaunch.identity).toEqual({ kind: 'none' });
  });

  it('still posts as the operator from a plain cockpit session with login off, which is the control', async () => {
    // The refusals above must not be a server that refuses everything: the only
    // difference here is a directory that is nobody's working copy.
    installState.loginEnabled = false;
    const { token, session, toolLaunch } = await launch(PLAIN_DIR, undefined);

    expect(token).toBeUndefined();
    const reply = await postFrom(session, toolLaunch, 'from the keyboard');

    expect(reply.posted).toBe(true);
    expect(lastAuthor()).toBe(harness.human);
  });
});
