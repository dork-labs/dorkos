/**
 * Who the Claude adapter mints a session's identity token FOR (spec
 * `agent-trust` §3.1, DOR-1264).
 *
 * The token rides the SDK subprocess env, and the name it carries is not
 * bookkeeping: `describeAgent` replays it to every in-session tool call, and the
 * rooms domain writes it straight onto the agent's author row
 * (`room-capabilities.ts` → `AuthorRegistry.resolveAgent`). So a token minted
 * under `agents.name` — the SLUG that addresses an agent, not the label that
 * renders it — renamed a live agent to `docs-writer` in every room message it
 * wrote and in the member list, and did it again on its next tool call.
 *
 * These tests mint against a REAL `AgentIdentityService` over a test DB and
 * resolve the token back out of the options handed to `query()`, so a token that
 * carries the wrong name fails here rather than in a room.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import {
  AGENT_TOKEN_ENV_VAR,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../../core/agent-identity/index.js';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>mock</env>'),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi
    .fn()
    .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));

const AGENT_CWD = '/mock/project';

function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

/**
 * A mesh that reports one agent at {@link AGENT_CWD}.
 *
 * The default carries the pair a real manifest has and the whole bug turned on:
 * a slug that addresses the agent and a different string that renders it. A fake
 * where the two are equal cannot tell which one was minted.
 */
function meshWithAgent(
  agent: { name: string; displayName?: string } = {
    name: 'docs-writer',
    displayName: 'Docs Writer',
  }
): AgentRegistryPort {
  return {
    getByPath: (cwd: string) =>
      cwd === AGENT_CWD ? { id: '01JAGENT0000000000000000', ...agent } : undefined,
    listWithPaths: () => [],
    updateLastSeen: () => {},
  } as unknown as AgentRegistryPort;
}

/** Drive one turn and return the options the SDK was launched with. */
async function launchWith(meshCore: AgentRegistryPort | null): Promise<Options> {
  let captured: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    captured = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  const opts: MessageSenderOpts = { cwd: AGENT_CWD, meshCore, onSdkSessionRebind: async () => {} };
  for await (const _event of executeSdkQuery('s1', 'hello', makeSession(), opts)) {
    // The launch options are what these tests read.
  }
  return captured!;
}

describe('executeSdkQuery — who the session token is minted for', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    initAgentIdentityService(db);
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('mints under the name a person reads, never the agent addressing slug', async () => {
    const options = await launchWith(meshWithAgent());

    const token = (options.env as Record<string, string>)[AGENT_TOKEN_ENV_VAR]!;
    const identity = await initAgentIdentityService(db).resolve(token);

    // `docs-writer` here is what the rooms domain writes onto the author row,
    // so this assertion is the rename the room showed (DOR-1264).
    expect(identity?.displayName).not.toBe('docs-writer');
    expect(identity?.displayName).toBe('Docs Writer');
    expect(identity?.agentPath).toBe(AGENT_CWD);
  });

  it('falls back to the slug for an agent that has no display name of its own', async () => {
    const options = await launchWith(meshWithAgent({ name: 'docs-writer' }));

    const token = (options.env as Record<string, string>)[AGENT_TOKEN_ENV_VAR]!;
    const identity = await initAgentIdentityService(db).resolve(token);

    // Nothing is invented: the slug is the only name this agent has.
    expect(identity?.displayName).toBe('docs-writer');
  });

  it('leaves a directory that hosts no agent unattributed, exactly as before', async () => {
    const options = await launchWith(null);

    expect((options.env as Record<string, string>)[AGENT_TOKEN_ENV_VAR]).toBeUndefined();
  });
});
