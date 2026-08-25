/**
 * The launch-account ladder as a LAUNCH sees it (spec `billing-account-ladder`,
 * ADR 260821-205323).
 *
 * `launch-account-ladder.test.ts` pins the resolver in isolation. This file pins
 * the two things only the launch path can answer, at the same
 * `sdkOptions.env.CLAUDE_CONFIG_DIR` seam `message-sender-account-pin.test.ts`
 * uses — the one the SDK subprocess actually reads:
 *
 * 1. **The ladder runs only at launch** (invariant 5). A session that already has
 *    an `accountRoot` — the account its transcript is on — ignores the hint, the
 *    agent's setting, and the server default. Billing cannot move mid-conversation.
 * 2. **The hint and the agent's manifest reach the spawn env, and stop there.**
 *    Nothing about the account is written back to the session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readManifest } from '@dorkos/shared/manifest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { configManager } from '../../../../core/config-manager.js';
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
  configManager: { get: vi.fn() },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));

/** Where a session already running lives — the account its transcript is on. */
const SETTLED = '/staged/claude-settled';
/** The account a person picked for this one session before sending. */
const HINT_ROOT = '/staged/claude-hint';
/** The account the agent's manifest pins it to. */
const AGENT_ROOT = '/staged/claude-agent';
/** The operator's server-wide default. */
const DEFAULT_ROOT = '/staged/claude-default';

/**
 * Point the mocked config manager at a registry holding both referenceable
 * accounts plus the server default.
 */
function stubConfig(): void {
  vi.mocked(configManager.get).mockImplementation(((key: string) =>
    key === 'runtimes'
      ? {
          claudeCode: {
            defaultAccount: DEFAULT_ROOT,
            accounts: [
              { id: 'acme-corp', path: HINT_ROOT, label: 'Acme Corp' },
              { id: 'personal', path: AGENT_ROOT, label: 'Personal' },
            ],
          },
        }
      : undefined) as typeof configManager.get);
}

/**
 * A session in the state this case is about.
 *
 * @param overrides - The fields that matter here.
 * @returns A session object shaped like the runtime's own.
 */
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

/**
 * Drive one turn against a stream that yields nothing.
 *
 * @param session - The session to run the turn on.
 * @param accountHint - The launch hint the route would have passed, if any.
 * @returns The SDK options the turn was launched with.
 */
async function runTurn(session: AgentSession, accountHint?: string): Promise<Options> {
  let captured: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    captured = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  const opts: MessageSenderOpts = { cwd: '/mock/project', onSdkSessionRebind: async () => {} };
  for await (const _event of executeSdkQuery(
    's1',
    'hello',
    session,
    opts,
    accountHint === undefined ? undefined : { accountHint }
  )) {
    // drain
  }
  return captured!;
}

/** The account the captured launch was pinned to. */
function pinnedAccount(options: Options): string | undefined {
  return (options.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR;
}

describe('the launch ladder at the spawn seam (spec billing-account-ladder)', () => {
  const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readManifest).mockResolvedValue(null);
    stubConfig();
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  });

  it('bills the hinted account on a launch that has none of its own', async () => {
    const options = await runTurn(makeSession({ accountRoot: undefined }), 'acme-corp');
    expect(pinnedAccount(options)).toBe(HINT_ROOT);
  });

  it("bills the AGENT's account when no hint came with the message", async () => {
    vi.mocked(readManifest).mockResolvedValue({
      account: 'personal',
    } as unknown as Awaited<ReturnType<typeof readManifest>>);

    const options = await runTurn(makeSession({ accountRoot: undefined }));
    expect(pinnedAccount(options)).toBe(AGENT_ROOT);
  });

  it("lets the session's hint beat the agent's own setting", async () => {
    vi.mocked(readManifest).mockResolvedValue({
      account: 'personal',
    } as unknown as Awaited<ReturnType<typeof readManifest>>);

    const options = await runTurn(makeSession({ accountRoot: undefined }), 'acme-corp');
    expect(pinnedAccount(options)).toBe(HINT_ROOT);
  });

  it('falls back to the server default when neither names an account', async () => {
    const options = await runTurn(makeSession({ accountRoot: undefined }));
    expect(pinnedAccount(options)).toBe(DEFAULT_ROOT);
  });

  it('launches anyway when the agent names an account that no longer exists', async () => {
    // Invariant 3, through the launch path rather than the resolver: a
    // hand-edited manifest or a removed account costs the override, never the
    // session.
    vi.mocked(readManifest).mockResolvedValue({
      account: 'deleted-last-week',
    } as unknown as Awaited<ReturnType<typeof readManifest>>);

    const options = await runTurn(makeSession({ accountRoot: undefined }));
    expect(pinnedAccount(options)).toBe(DEFAULT_ROOT);
  });

  // Invariant 5 — the ladder runs ONLY at launch.

  it('ignores the hint on a session whose account disk already settled', async () => {
    const options = await runTurn(
      makeSession({ hasStarted: true, accountRoot: SETTLED }),
      'acme-corp'
    );
    expect(pinnedAccount(options)).toBe(SETTLED);
  });

  it("ignores the agent's account and the server default on a settled session", async () => {
    vi.mocked(readManifest).mockResolvedValue({
      account: 'personal',
    } as unknown as Awaited<ReturnType<typeof readManifest>>);

    const options = await runTurn(makeSession({ hasStarted: true, accountRoot: SETTLED }));
    expect(pinnedAccount(options)).toBe(SETTLED);
  });

  it('writes the resolved account back onto nothing — disk stays the truth', async () => {
    // Invariant 1: the ladder decides where a process is SENT and stores no
    // answer. A session whose account was resolved here must look, afterwards,
    // exactly as it did before.
    const session = makeSession({ accountRoot: undefined });
    await runTurn(session, 'acme-corp');
    expect(session.accountRoot).toBeUndefined();
  });
});
