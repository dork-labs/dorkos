/**
 * DOR-107 — slash-command dispatch.
 *
 * The CLI only parses a slash command when `/` starts the prompt, so
 * executeSdkQuery must skip the additional-context prepend for known commands
 * and pass the content through bare. Plain turns prepend the rendered bag from
 * `messageOpts.additionalContext` (ADR-0273).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeSdkQuery,
  detectSlashCommandName,
  type MessageSenderOpts,
} from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import { query } from '@anthropic-ai/claude-agent-sdk';

const { mockRenderContextEntry } = vi.hoisted(() => ({
  // Stand in for the real formatter: render each entry as `<kind>mock</kind>`
  // so prepend behavior is observable without coupling to exact formatting.
  mockRenderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>mock</env>'),
  renderContextEntry: mockRenderContextEntry,
}));

/** A one-entry git_status bag used to exercise the prepend path. */
const GIT_BAG: AdditionalContext = [
  { kind: 'git_status', scope: 'per-turn', data: { isRepo: true, branch: 'main', clean: true } },
];
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi.fn().mockReturnValue({
    tasks: true,
    relay: true,
    mesh: true,
    adapter: true,
  }),
  buildAllowedTools: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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
  configManager: {
    get: vi.fn().mockReturnValue(undefined),
  },
}));

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

function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return {
    cwd: '/mock/project',
    sdkSessionIndex: new Map(),
    sessionMapKey: 's1',
    ...overrides,
  };
}

/**
 * Run executeSdkQuery against an empty SDK stream and return the user-message
 * content that was handed to the SDK's prompt input.
 *
 * @param content - The user message text.
 * @param opts - Runtime dependencies.
 * @param messageOpts - Optional per-turn opts carrying the additional-context bag.
 */
async function dispatchAndCapturePrompt(
  content: string,
  opts: MessageSenderOpts,
  messageOpts?: MessageOpts
): Promise<string> {
  let capturedPrompt: AsyncGenerator<{ message: { content: string } }> | undefined;

  vi.mocked(query).mockImplementation((args) => {
    capturedPrompt = args.prompt as typeof capturedPrompt;
    return {
      [Symbol.asyncIterator]: async function* () {}, // empty SDK stream
    } as unknown as ReturnType<typeof query>;
  });

  const events = [];
  for await (const event of executeSdkQuery('s1', content, makeSession(), opts, messageOpts)) {
    events.push(event);
  }

  const first = await capturedPrompt![Symbol.asyncIterator]().next();
  return (first.value as { message: { content: string } }).message.content;
}

describe('detectSlashCommandName', () => {
  it.each([
    ['/compact', 'compact'],
    ['/compact focus on the API changes', 'compact'],
    ['/git:commit', 'git:commit'],
    ['/chat:session-switch-test extra args', 'chat:session-switch-test'],
    ['  /compact', 'compact'],
    ['/compact\nwith a second line', 'compact'],
    ['/mcp__server__prompt', 'mcp__server__prompt'],
  ])('detects %j as command %j', (content, expected) => {
    expect(detectSlashCommandName(content)).toBe(expected);
  });

  it.each([
    ['/etc/hosts is broken'],
    ['run /compact please'],
    ['hello world'],
    ['/'],
    ['/ spaced out'],
    [''],
  ])('treats %j as plain text', (content) => {
    expect(detectSlashCommandName(content)).toBeNull();
  });
});

describe('executeSdkQuery command dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a known command through bare, without prepending the context bag', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/compact', '/clear']) }),
      { additionalContext: GIT_BAG }
    );

    expect(prompt).toBe('/compact');
    expect(mockRenderContextEntry).not.toHaveBeenCalled();
  });

  it('preserves command arguments on dispatch', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact focus on the API changes',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/compact']) }),
      { additionalContext: GIT_BAG }
    );

    expect(prompt).toBe('/compact focus on the API changes');
  });

  it('trims surrounding whitespace so the CLI sees a leading slash', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '  /compact  ',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/compact']) }),
      { additionalContext: GIT_BAG }
    );

    expect(prompt).toBe('/compact');
  });

  it('enriches a command-shaped message whose name is not a known command', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/other']) }),
      { additionalContext: GIT_BAG }
    );

    expect(prompt).toBe('<git_status>mock</git_status>\n\n/compact');
  });

  it('passes command-shaped content through when the SDK cache is cold (null)', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(null) }),
      { additionalContext: GIT_BAG }
    );

    expect(prompt).toBe('/compact');
  });

  it('enriches multi-segment paths that merely start with a slash', async () => {
    const getKnownCommands = vi.fn().mockResolvedValue(null);
    const prompt = await dispatchAndCapturePrompt(
      '/etc/hosts is broken',
      makeOpts({ getKnownCommands }),
      { additionalContext: GIT_BAG }
    );

    expect(prompt).toBe('<git_status>mock</git_status>\n\n/etc/hosts is broken');
    expect(getKnownCommands).not.toHaveBeenCalled();
  });

  it('enriches commands when no getKnownCommands resolver is provided', async () => {
    const prompt = await dispatchAndCapturePrompt('/compact', makeOpts(), {
      additionalContext: GIT_BAG,
    });

    expect(prompt).toBe('<git_status>mock</git_status>\n\n/compact');
  });

  it('enriches ordinary messages unchanged', async () => {
    const getKnownCommands = vi.fn().mockResolvedValue(['/compact']);
    const prompt = await dispatchAndCapturePrompt('hello world', makeOpts({ getKnownCommands }), {
      additionalContext: GIT_BAG,
    });

    expect(prompt).toBe('<git_status>mock</git_status>\n\nhello world');
    expect(getKnownCommands).not.toHaveBeenCalled();
  });

  it('leaves content pristine on a plain turn with no additional context', async () => {
    const prompt = await dispatchAndCapturePrompt('hello world', makeOpts());
    expect(prompt).toBe('hello world');
  });

  it('prepends multiple rendered entries joined by a blank line', async () => {
    const prompt = await dispatchAndCapturePrompt('hello world', makeOpts(), {
      additionalContext: [
        { kind: 'git_status', scope: 'per-turn', data: { isRepo: true } },
        { kind: 'queue_note', scope: 'per-turn', data: { composedDuringPrevTurn: true } },
      ],
    });

    expect(prompt).toBe(
      '<git_status>mock</git_status>\n\n<queue_note>mock</queue_note>\n\nhello world'
    );
  });
});

/** Drive executeSdkQuery against a mocked SDK stream that yields the given messages. */
async function runWithSdkStream(
  messages: Array<Record<string, unknown>>,
  opts: MessageSenderOpts
): Promise<void> {
  vi.mocked(query).mockImplementation(
    () =>
      ({
        [Symbol.asyncIterator]: async function* () {
          for (const m of messages) yield m;
        },
      }) as unknown as ReturnType<typeof query>
  );
  for await (const _event of executeSdkQuery('s1', 'hi', makeSession(), opts)) {
    // drain
  }
}

describe('executeSdkQuery — commands_changed (DOR-108)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the command cache via onCommandsChanged on a mid-session push', async () => {
    const onCommandsChanged = vi.fn();
    await runWithSdkStream(
      [
        {
          type: 'system',
          subtype: 'commands_changed',
          commands: [
            { name: '/usage', description: 'Show usage', argumentHint: '', aliases: ['cost'] },
            { name: '/new', description: 'New cmd', argumentHint: '' },
          ],
        },
      ],
      makeOpts({ onCommandsChanged })
    );

    expect(onCommandsChanged).toHaveBeenCalledTimes(1);
    const arg = onCommandsChanged.mock.calls[0][0] as Array<{ name: string; aliases?: string[] }>;
    expect(arg.map((c) => c.name)).toEqual(['/usage', '/new']);
    expect(arg[0].aliases).toEqual(['cost']);
    expect(arg[1].aliases).toBeUndefined();
  });

  it('does not call onCommandsChanged when no commands_changed message arrives', async () => {
    const onCommandsChanged = vi.fn();
    await runWithSdkStream(
      [{ type: 'system', subtype: 'status', status: 'requesting' }],
      makeOpts({ onCommandsChanged })
    );

    expect(onCommandsChanged).not.toHaveBeenCalled();
  });
});
