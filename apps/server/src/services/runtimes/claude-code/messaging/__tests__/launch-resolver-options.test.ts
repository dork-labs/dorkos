/**
 * The launch options DorkOS hands every Claude Code turn.
 *
 * These are the settings no other test can defend, because getting one wrong
 * costs a whole surface without costing a single failing assertion anywhere
 * else: the fixtures that feed every other suite keep supplying the frames a
 * real model would have stopped sending. Each case here pins one such setting
 * against the reason it exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { CLASSIFIER_CONTEXT_MATCHER } from '../classifier-context.js';

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

/** A minimal cold session — enough for one launch to be planned. */
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

/** Sender options with the one required field. */
function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {}, ...overrides };
}

/** Drive one turn and hand back the options the SDK was launched with. */
async function captureSdkOptions(): Promise<Options> {
  let capturedOptions: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    capturedOptions = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  for await (const _event of executeSdkQuery('s1', 'hello', makeSession(), makeOpts())) {
    // Drained: the launch is what is under test, not the stream.
  }
  return capturedOptions!;
}

describe('the launch options every Claude Code turn is given', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('turns the task and todo tools on, which no newer model gets by default', async () => {
    const options = await captureSdkOptions();

    const env = options.env as Record<string, string | undefined>;
    expect(
      env.CLAUDE_CODE_ENABLE_TODO_TOOLS,
      'without this the model never calls TodoWrite/TaskCreate/TaskUpdate, so the todo panel ' +
        'and the Tasks surface stay empty forever and nothing anywhere errors'
    ).toBe('1');
  });

  it('registers the PostToolUse hook that tells auto mode about DorkOS tools', async () => {
    // Spec `auto-mode-classifier-context`. Nothing else can catch this: a hook
    // that was never registered produces no error, no log line and no failing
    // assertion anywhere — auto mode just goes on guessing about DorkOS's own
    // tools, exactly as it did before, and the whole change is a no-op nobody
    // notices.
    const options = await captureSdkOptions();

    const matchers = options.hooks?.PostToolUse ?? [];
    expect(matchers).toHaveLength(1);
    expect(
      matchers[0]?.matcher,
      'the CLI reads a word-characters-only matcher as a list of exact tool names, so the ' +
        'registration has to hand it a pattern \u2014 see CLASSIFIER_CONTEXT_MATCHER'
    ).toBe(CLASSIFIER_CONTEXT_MATCHER);

    const hook = matchers[0]!.hooks[0]!;
    const result = (await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__dorkos__mesh_list',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'toolu_1',
      } as never,
      'toolu_1',
      { signal: new AbortController().signal }
    )) as Record<string, unknown>;

    const specific = result.hookSpecificOutput as Record<string, unknown>;
    expect(specific?.hookEventName).toBe('PostToolUse');
    expect(specific?.classifierContext).toContain("passed DorkOS's own permission check");
  });

  it('sends the plugin list over stdin rather than on the command line', async () => {
    const options = await captureSdkOptions();

    expect(
      options.pluginDelivery,
      'ADR-0239 activates every enabled marketplace plugin through `options.plugins`, and on ' +
        'argv that list is an unbounded count of absolute paths — past Windows\u2019 command-line ' +
        'length limit the CLI simply stops starting'
    ).toBe('initialize');
  });
});
