/**
 * DOR-107 — slash-command dispatch.
 *
 * The CLI only parses a slash command when `/` starts the prompt, so
 * executeSdkQuery must skip the per-message context prepend for known
 * commands and pass the content through bare.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeSdkQuery,
  detectSlashCommandName,
  type MessageSenderOpts,
} from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const { mockBuildPerMessageContext } = vi.hoisted(() => ({
  mockBuildPerMessageContext: vi.fn().mockResolvedValue('<git_status>mock</git_status>'),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>mock</env>'),
  buildPerMessageContext: mockBuildPerMessageContext,
}));
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
 */
async function dispatchAndCapturePrompt(content: string, opts: MessageSenderOpts): Promise<string> {
  let capturedPrompt: AsyncGenerator<{ message: { content: string } }> | undefined;

  vi.mocked(query).mockImplementation((args) => {
    capturedPrompt = args.prompt as typeof capturedPrompt;
    return {
      [Symbol.asyncIterator]: async function* () {}, // empty SDK stream
    } as unknown as ReturnType<typeof query>;
  });

  const events = [];
  for await (const event of executeSdkQuery('s1', content, makeSession(), opts)) {
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
    mockBuildPerMessageContext.mockResolvedValue('<git_status>mock</git_status>');
  });

  it('passes a known command through bare, without per-message context', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/compact', '/clear']) })
    );

    expect(prompt).toBe('/compact');
    expect(mockBuildPerMessageContext).not.toHaveBeenCalled();
  });

  it('preserves command arguments on dispatch', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact focus on the API changes',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/compact']) })
    );

    expect(prompt).toBe('/compact focus on the API changes');
  });

  it('trims surrounding whitespace so the CLI sees a leading slash', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '  /compact  ',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/compact']) })
    );

    expect(prompt).toBe('/compact');
  });

  it('enriches a command-shaped message whose name is not a known command', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(['/other']) })
    );

    expect(prompt).toBe('<git_status>mock</git_status>\n\n/compact');
  });

  it('passes command-shaped content through when the SDK cache is cold (null)', async () => {
    const prompt = await dispatchAndCapturePrompt(
      '/compact',
      makeOpts({ getKnownCommands: vi.fn().mockResolvedValue(null) })
    );

    expect(prompt).toBe('/compact');
  });

  it('enriches multi-segment paths that merely start with a slash', async () => {
    const getKnownCommands = vi.fn().mockResolvedValue(null);
    const prompt = await dispatchAndCapturePrompt(
      '/etc/hosts is broken',
      makeOpts({ getKnownCommands })
    );

    expect(prompt).toBe('<git_status>mock</git_status>\n\n/etc/hosts is broken');
    expect(getKnownCommands).not.toHaveBeenCalled();
  });

  it('enriches commands when no getKnownCommands resolver is provided', async () => {
    const prompt = await dispatchAndCapturePrompt('/compact', makeOpts());

    expect(prompt).toBe('<git_status>mock</git_status>\n\n/compact');
  });

  it('enriches ordinary messages unchanged', async () => {
    const getKnownCommands = vi.fn().mockResolvedValue(['/compact']);
    const prompt = await dispatchAndCapturePrompt('hello world', makeOpts({ getKnownCommands }));

    expect(prompt).toBe('<git_status>mock</git_status>\n\nhello world');
    expect(getKnownCommands).not.toHaveBeenCalled();
  });
});
