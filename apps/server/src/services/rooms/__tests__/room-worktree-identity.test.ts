/**
 * @vitest-environment node
 *
 * A room turn in a room WITH FILES acts as its agent — and as nobody else
 * (DOR-2091).
 *
 * Since DOR-1597 such a turn runs in the agent's worktree,
 * `<dorkHome>/rooms/<roomId>/worktrees/<slug>`, which hosts no registered agent.
 * Every runtime answered "who is this?" with an exact lookup of that directory,
 * so the launch minted no identity token, the in-session tools resolved nobody,
 * and with login on every room verb refused as `UNIDENTIFIED_CALLER`. The agent
 * read the message, did the work, and could not say a word: on 2026-09-16 two
 * agents asked a question in one room both went silent this way. With login OFF
 * the same calls fell through to the OPERATOR.
 *
 * Driven through the real claude-code launch (`resolveLaunch`), the real
 * in-session tool server (`createDorkOsToolServer`) over an in-memory MCP client,
 * the real identity service and the real rooms capabilities — the path the
 * defect lived on. The working-copy port is a map with the manager's semantics;
 * the manager's own record is pinned against real git in
 * `repo/__tests__/room-worktree-manager.test.ts`.
 *
 * Seeded defects, each run red before the fix and after it:
 *
 * - Minting from `getByPath(effectiveCwd)` again (the line the issue named)
 *   reddens "mints the agent's token" and "posts as the agent" in both login
 *   postures — the in-session identity reads the token store, so no mint means
 *   no identity.
 * - Building the tool server's identity from the raw `session.cwd`, as it did
 *   before, reddens "posts as the agent" and both refusal rows in both
 *   postures: login on answers `UNIDENTIFIED_CALLER` (the field report,
 *   exactly), login off posts as the operator.
 * - Dropping the cross-check against the turn's agent reddens "a turn for Ben
 *   in Ana's worktree" in both postures, which then posts as Ana.
 * - Anchoring a working copy nobody vouches for to itself reddens the
 *   unknown-worktree row in both postures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
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
  setWorkingCopyOwnerPort,
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

const ANA = '/agents/ana';
const BEN = '/agents/ben';
const WORKTREES = '/dork/rooms/01ROOMWITHFILES/worktrees';
const ANA_WORKTREE = `${WORKTREES}/ana-1a2b3c4d`;
/** A working copy by location that the manager never handed to anyone. */
const STRAY_WORKTREE = `${WORKTREES}/ana-00000000`;
/** A cockpit session in a plain directory: the control for the refusals. */
const PLAIN_DIR = '/projects/scratch';

/** The mesh as a launch sees it: two registered agents, keyed by their folders. */
const mesh = {
  getByPath: (p: string) =>
    ({
      [ANA]: { id: 'agent-ana', name: 'ana', displayName: 'Ana' },
      [BEN]: { id: 'agent-ben', name: 'ben', displayName: 'Ben' },
    })[p],
  getSubjectByPath: () => undefined,
  updateLastSeen: vi.fn(),
} as unknown as AgentRegistryPort;

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

describe('a room turn in a room with files', () => {
  let harness: RoomHarness;
  let registry: CapabilityRegistry;
  let roomId: string;

  beforeEach(() => {
    installState.loginEnabled = true;
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
    // The manager's record: Ana was handed her worktree, and nobody the stray.
    setWorkingCopyOwnerPort({
      ownerOf: (dir) =>
        path.dirname(path.resolve(dir)) === WORKTREES
          ? { owner: path.resolve(dir) === ANA_WORKTREE ? ANA : null }
          : null,
    });
  });

  afterEach(() => {
    setWorkingCopyOwnerPort(undefined);
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
    forAgent: string | undefined
  ): Promise<{ token: string | undefined; toolLaunch: McpServerLaunch; session: AgentSession }> {
    let toolLaunch: McpServerLaunch | undefined;
    // A room session created on the worktree rung: its own cwd IS the worktree.
    const session: AgentSession = {
      sdkSessionId: 'sdk-1',
      lastActivity: Date.now(),
      permissionMode: 'default',
      hasStarted: false,
      pendingInteractions: new Map(),
      eventQueue: [],
      cwd,
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

    it("mints the agent's token for a turn standing in its worktree", async () => {
      const { token, toolLaunch } = await launch(ANA_WORKTREE, ANA);

      expect(token, 'the worktree hosts no agent; the anchor must find Ana anyway').toBeDefined();
      const identity = await getAgentIdentityService()!.resolve(token!);
      expect(identity?.agentPath).toBe(ANA);
      expect(toolLaunch.identity).toEqual({ kind: 'path', agentPath: ANA });
    });

    it('posts as the agent, not as nobody and not as the operator', async () => {
      const { session, toolLaunch } = await launch(ANA_WORKTREE, ANA);

      const reply = await postFrom(session, toolLaunch, 'here is the plan');

      expect(reply.code).toBeUndefined();
      expect(reply.posted).toBe(true);
      expect(lastAuthor()).toBe(anaAuthor());
      expect(lastAuthor()).not.toBe(harness.human);
    });

    it("refuses a turn for Ben that stands in Ana's worktree: no token, and no post as anyone", async () => {
      const before = lastAuthor();
      const { token, session, toolLaunch } = await launch(ANA_WORKTREE, BEN);

      expect(token).toBeUndefined();
      expect(toolLaunch.identity).toMatchObject({ kind: 'refused' });
      const reply = await postFrom(session, toolLaunch, 'posting as Ana, apparently');

      expect(reply.posted).toBeUndefined();
      expect(reply.code).toBe('AGENT_IDENTITY_UNVERIFIED');
      expect(lastAuthor()).toBe(before);
    });

    it('refuses a worktree nobody vouches for — never the operator', async () => {
      const before = lastAuthor();
      const { token, session, toolLaunch } = await launch(STRAY_WORKTREE, ANA);

      expect(token).toBeUndefined();
      const reply = await postFrom(session, toolLaunch, 'whose am I?');

      expect(reply.posted).toBeUndefined();
      expect(reply.code).toBe('AGENT_IDENTITY_UNVERIFIED');
      expect(lastAuthor()).toBe(before);
    });
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
