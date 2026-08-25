/**
 * What the turn's SDK subprocess is told its per-call MCP tool timeout is
 * (DOR-987).
 *
 * The subprocess inherits the whole of `process.env`, and `MCP_TOOL_TIMEOUT` is
 * a supported claude CLI variable an operator has real reason to lower (a flaky
 * external MCP server that hangs). Lowered below the in-session approval hold's
 * cap, every held destructive call would die mid-wait and return an ERROR to the
 * model — strictly worse than the poll flow the hold replaced, which is the one
 * outcome the feature must never produce.
 *
 * These pin the floor at the seam the subprocess actually reads, `options.env`,
 * because a floor applied anywhere else is a floor the spawn does not have.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import { MCP_TOOL_TIMEOUT_FLOOR_MS, mcpToolTimeoutFloorEnv } from '../mcp-tool-timeout-env.js';
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

  it('raises a value that would kill a held approval to the floor', async () => {
    // 60s: a plausible thing to export for a flaky external MCP server, and
    // shorter than the hold cap — so every approval a person took a minute to
    // answer would come back an error instead of a result.
    process.env.MCP_TOOL_TIMEOUT = '60000';

    expect(forwardedTimeout(await runTurn())).toBe(String(MCP_TOOL_TIMEOUT_FLOOR_MS));
  });

  it('leaves a value that already clears the floor exactly as the operator set it', async () => {
    const generous = String(MCP_TOOL_TIMEOUT_FLOOR_MS * 2);
    process.env.MCP_TOOL_TIMEOUT = generous;

    expect(forwardedTimeout(await runTurn())).toBe(generous);
  });

  it('writes nothing when the operator set nothing', async () => {
    // The CLI's own ~27.8h default already clears the hold cap by hours, so an
    // unset variable must stay unset rather than gain a DorkOS opinion.
    expect(forwardedTimeout(await runTurn())).toBeUndefined();
  });
});

describe('mcpToolTimeoutFloorEnv — the gate is the CLI’s own, not the config field’s', () => {
  const FLOORED = { MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_FLOOR_MS) };

  it('raises a SUB-SECOND value, which the CLI clamps up to 1000ms rather than discarding', () => {
    // The bug the re-review caught. The `>= 1000` rule is documented on the
    // per-server `timeout` FIELD; the env var's branch is `> 0`, and its clamp
    // is `Math.max(value, 1000)`. So `500` is not ignored — it is a ONE-SECOND
    // ceiling on every tool call, which kills a hold before the card renders.
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: '500' })).toEqual(FLOORED);
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: '999' })).toEqual(FLOORED);
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: '1' })).toEqual(FLOORED);
  });

  it('reads a unit-suffixed value the way the CLI does', () => {
    // The CLI parses with `parseInt`, so this is thirty seconds to it. Read as
    // `Number()` it is NaN, and a hold would quietly die at 30s while the
    // parser mismatch made it look like there was nothing to correct.
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: '30000ms' })).toEqual(FLOORED);
  });

  it('leaves alone the values the CLI genuinely falls back to its default on', () => {
    // Zero and negatives fail the CLI's `> 0` gate, and a value with no leading
    // digits gives `parseInt` nothing — all three keep the ~27.8h default,
    // which already clears the hold cap by hours.
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: '0' })).toEqual({});
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: '-5' })).toEqual({});
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: 'abc' })).toEqual({});
  });

  it('raises a value one tick below the floor, and leaves the floor itself', () => {
    // The boundary, from the side that matters: one millisecond short is still
    // a hold that can die before the person answers.
    expect(
      mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_FLOOR_MS - 1) })
    ).toEqual(FLOORED);
    expect(mcpToolTimeoutFloorEnv({ MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_FLOOR_MS) })).toEqual(
      {}
    );
  });
});
