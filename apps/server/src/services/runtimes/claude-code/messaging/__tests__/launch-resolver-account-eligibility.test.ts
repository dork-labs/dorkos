/**
 * The turn's own launch holds to the account rules (spec `flow-multiproject`
 * §8.4): a session with no account yet, whose ladder refuses in its folder's
 * project, never reaches the SDK, and the turn fails with the plain sentence.
 * A session that already has an account keeps it: the rule applies when an
 * account is picked, never mid-conversation.
 *
 * Driven through `executeSdkQuery`, the same seam
 * `message-sender-account-ladder.test.ts` uses; the folder (`/mock/project`)
 * is one project, so the rules alone decide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rules = vi.hoisted(() => ({ claudeCode: {} as Record<string, unknown> }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) =>
      key === 'runtimes' ? { claudeCode: rules.claudeCode } : undefined
    ),
  },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../../core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async (cwd: string | null | undefined) =>
    cwd === '/mock/project' ? { root: '/mock/project', name: 'client-app' } : null
  ),
}));

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { AccountNotAllowedError } from '../../../../core/usage/account-eligibility.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';

const WORK_ROOT = '/staged/claude-work';
const PERSONAL_ROOT = '/staged/claude-personal';

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

let captured: Options | undefined;

async function runTurn(session: AgentSession, accountHint?: string): Promise<void> {
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
}

async function turnError(session: AgentSession, accountHint?: string): Promise<unknown> {
  try {
    await runTurn(session, accountHint);
  } catch (err) {
    return err;
  }
  throw new Error('expected the turn to fail');
}

const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  vi.clearAllMocks();
  registerEveryFolderAsHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  captured = undefined;
  vi.mocked(query).mockImplementation((args) => {
    captured = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  // Work is kept to another project; Personal may work anywhere.
  rules.claudeCode = {
    defaultAccount: null,
    accounts: [
      { id: 'work', path: WORK_ROOT, label: 'Work', onlyProjects: ['/elsewhere/other'] },
      { id: 'personal', path: PERSONAL_ROOT, label: 'Personal', onlyProjects: null },
    ],
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
  };
});

afterEach(() => {
  clearTestHomes();
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

describe('a new session whose ladder refuses', () => {
  it('fails the turn with the sentence for a picked account, and never reaches the SDK', async () => {
    const err = await turnError(makeSession({ accountRoot: undefined }), 'work');

    expect(err).toBeInstanceOf(AccountNotAllowedError);
    expect((err as Error).message).toBe(
      "Work can't be used in client-app. It's set to work only in other. Pick another account, or change this in Settings → Runtimes."
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('fails the turn when no account at all may work in the project', async () => {
    rules.claudeCode.defaultAccountOnlyProjects = ['/elsewhere/other'];
    (rules.claudeCode.accounts as Record<string, unknown>[])[1].onlyProjects = ['/elsewhere/other'];

    const err = await turnError(makeSession({ accountRoot: undefined }));

    expect(err).toBeInstanceOf(AccountNotAllowedError);
    expect((err as Error).message).toBe(
      'No account is allowed to work in client-app. Choose which accounts it may use in Settings → Runtimes.'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('launches on a picked account that may work here (control)', async () => {
    await runTurn(makeSession({ accountRoot: undefined }), 'personal');
    expect((captured!.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR).toBe(
      PERSONAL_ROOT
    );
  });

  it('keeps a session that already has an account on it, whatever the rules say now', async () => {
    await runTurn(makeSession({ accountRoot: WORK_ROOT }), 'personal');
    expect(query).toHaveBeenCalledTimes(1);
    expect((captured!.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR).toBe(WORK_ROOT);
  });
});
