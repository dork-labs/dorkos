/**
 * What the turn's SDK subprocess is told its per-call MCP tool timeout is.
 *
 * `MCP_TOOL_TIMEOUT` is a supported Claude CLI variable an operator has real
 * reason to lower (a flaky external MCP server that hangs), and it governs EVERY
 * MCP server in the subprocess. DorkOS used to raise an inherited value to the
 * in-session approval hold's cap, because a low one killed every held
 * destructive call mid-wait (DOR-987) — and in doing so took away the only thing
 * the operator had set it for.
 *
 * The `dorkos` server now carries its own per-call ceiling instead
 * (`mcp-tools/tool-timeout.ts`), so the rewrite is gone. These pin that removal
 * at the seam the subprocess actually reads, `options.env`: whatever the
 * operator set arrives there unchanged, and an unset variable stays unset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
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

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {}, ...overrides };
}

/** Drive one turn with a stream that yields nothing, and return the SDK options. */
async function runTurn(): Promise<Options> {
  let captured: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    captured = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  for await (const _event of executeSdkQuery('s1', 'hello', makeSession(), makeOpts())) {
    // drain
  }
  return captured!;
}

/** What the subprocess would actually see (Node drops `undefined` values). */
function forwardedTimeout(options: Options): string | undefined {
  return (options.env as Record<string, string | undefined>).MCP_TOOL_TIMEOUT;
}

describe('executeSdkQuery — inherited MCP_TOOL_TIMEOUT', () => {
  const ORIGINAL = process.env.MCP_TOOL_TIMEOUT;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MCP_TOOL_TIMEOUT;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MCP_TOOL_TIMEOUT;
    else process.env.MCP_TOOL_TIMEOUT = ORIGINAL;
  });

  it('passes a short value through untouched, because it no longer reaches the hold', async () => {
    // 60s: a plausible thing to export for a flaky external MCP server, and
    // shorter than the approval hold's cap. It used to be raised to that cap,
    // which applied the operator's fix to nothing and their loss to everything.
    // The `dorkos` server states its own ceiling now, so this can mean what it
    // says again.
    process.env.MCP_TOOL_TIMEOUT = '60000';

    expect(forwardedTimeout(await runTurn())).toBe('60000');
  });

  it('passes a generous value through untouched', async () => {
    process.env.MCP_TOOL_TIMEOUT = '900000';

    expect(forwardedTimeout(await runTurn())).toBe('900000');
  });

  it('writes nothing when the operator set nothing', async () => {
    // An unset variable must stay unset rather than gain a DorkOS opinion: the
    // CLI's own ~27.8h default is what every other MCP server should get.
    expect(forwardedTimeout(await runTurn())).toBeUndefined();
  });
});
