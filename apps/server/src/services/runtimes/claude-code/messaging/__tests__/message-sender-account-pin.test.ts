/**
 * Which Claude Code account a turn runs and bills on (spec `claude-code-accounts`
 * §8 D8 + C2).
 *
 * The operator runs one account per paying client, so a turn on the wrong account
 * is a real-money, real-trust failure. Two properties are pinned here, at the
 * `sdkOptions.env` seam the SDK subprocess actually reads:
 *
 * 1. The account is spelled out EXPLICITLY on every spawn, never inherited from
 *    `process.env`. D8 lets rename and fork point the in-process SDK at an
 *    account by mutating `process.env.CLAUDE_CONFIG_DIR` process-globally; that
 *    is only survivable while a concurrently spawning query ignores it.
 * 2. A resume FAILURE, which restarts the turn as a brand-new SDK session, keeps
 *    the ORIGINAL account (C2). Dropping the pin there would silently migrate a
 *    client's conversation onto whichever account happened to be active.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
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

/** The ACTIVE account — what a session with no known account of its own runs on. */
const ACTIVE = '/staged/claude-active';
/** A paying client's account: where a resumed session's transcript lives. */
const ACCOUNT_B = '/staged/claude2';

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

/** The `CLAUDE_CONFIG_DIR` each `query()` call was handed, in call order. */
function pinnedAccounts(): (string | undefined)[] {
  return vi
    .mocked(query)
    .mock.calls.map(
      (call) =>
        (call[0].options?.env as Record<string, string | undefined> | undefined)?.[
          'CLAUDE_CONFIG_DIR'
        ]
    );
}

/** Drive one turn with a stream that yields nothing, and return the SDK options. */
async function runTurn(session: AgentSession): Promise<Options> {
  let captured: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    captured = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  for await (const _event of executeSdkQuery('s1', 'hello', session, makeOpts())) {
    // drain
  }
  return captured!;
}

describe('executeSdkQuery — Claude account pin', () => {
  const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    // A launching terminal that exported an account. Every assertion below is
    // about DorkOS deciding the account rather than inheriting this one.
    process.env.CLAUDE_CONFIG_DIR = ACTIVE;
  });

  afterEach(() => {
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  });

  it("pins the session's OWN account, not the active one, when disk resolved it", async () => {
    const options = await runTurn(makeSession({ hasStarted: true, accountRoot: ACCOUNT_B }));

    const env = options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_B);
    // The pin is additive: the existing control var still rides along.
    expect(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
  });

  it('pins the ACTIVE account for a session with no account of its own', async () => {
    // `undefined` means unknown — a brand-new session with no transcript yet —
    // and must resolve to the active account, never to an error.
    const options = await runTurn(makeSession({ accountRoot: undefined }));

    expect((options.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR).toBe(ACTIVE);
  });

  it('spells the account out even while process.env names a DIFFERENT one', async () => {
    // The D8 dependency, as a test: rename/fork mutate this very variable
    // process-globally, so a spawn that merely inherited it would be captured by
    // that window and bill the wrong client.
    process.env.CLAUDE_CONFIG_DIR = '/staged/claude-transiently-locked';

    const options = await runTurn(makeSession({ hasStarted: true, accountRoot: ACCOUNT_B }));

    expect((options.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR).toBe(ACCOUNT_B);
  });

  it('leaves the variable ABSENT when absence is what names the default account', async () => {
    // AC1: at defaults, behavior is identical to today. Claude Code takes the
    // unsuffixed macOS Keychain name exactly when CLAUDE_CONFIG_DIR is UNSET, so
    // writing the default path where nothing was set would point the CLI at a
    // Keychain entry that does not exist and break sign-in.
    delete process.env.CLAUDE_CONFIG_DIR;
    const defaultRoot = path.join(os.homedir(), '.claude');

    const options = await runTurn(makeSession({ accountRoot: defaultRoot }));

    const env = options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Present-as-undefined, not merely inherited: Node drops undefined values
    // when it builds the child env, so this also ERASES an inherited value.
    expect('CLAUDE_CONFIG_DIR' in env).toBe(true);
  });

  it('keeps the original account when a resume failure restarts as a new session (C2)', async () => {
    // The retry sets `hasStarted = false` and recurses. The new SDK session's
    // transcript lands under whatever root the retry pins, so the pin must still
    // be the account that owns the conversation.
    const session = makeSession({ hasStarted: true, accountRoot: ACCOUNT_B });
    let call = 0;
    vi.mocked(query).mockImplementation(() => {
      call += 1;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (call === 1) throw new Error('Session not found');
        },
      } as unknown as ReturnType<typeof query>;
    });

    for await (const _event of executeSdkQuery('s1', 'hello', session, makeOpts())) {
      // drain
    }

    // Both attempts, so a pin that survived only the first would be caught.
    expect(pinnedAccounts()).toEqual([ACCOUNT_B, ACCOUNT_B]);
    // The retry really did restart as new — otherwise this test would pass for
    // the wrong reason (no retry, one call, nothing to migrate).
    expect(vi.mocked(query).mock.calls[1]![0].options?.resume).toBeUndefined();
    expect(session.accountRoot).toBe(ACCOUNT_B);
  });

  it('keeps the original account when a stale resume ANCHOR forces a retry', async () => {
    // The sibling recovery path: drops `resumeSessionAt` and resumes plainly.
    // It recurses through the same seam, so it gets the same guarantee.
    const session = makeSession({
      hasStarted: true,
      accountRoot: ACCOUNT_B,
      lastAssistantUuid: 'gone-uuid',
    });
    let call = 0;
    vi.mocked(query).mockImplementation(() => {
      call += 1;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (call === 1) throw new Error('No message found with message.uuid of: gone-uuid');
        },
      } as unknown as ReturnType<typeof query>;
    });

    for await (const _event of executeSdkQuery('s1', 'hello', session, makeOpts())) {
      // drain
    }

    expect(pinnedAccounts()).toEqual([ACCOUNT_B, ACCOUNT_B]);
    expect(vi.mocked(query).mock.calls[1]![0].options?.resumeSessionAt).toBeUndefined();
  });
});
