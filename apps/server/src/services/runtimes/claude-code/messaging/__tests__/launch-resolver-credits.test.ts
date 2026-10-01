/**
 * Who pays for a Claude Code turn, at the launch (ADR 261001-000811).
 *
 * The folder a session runs in decides: the DorkOS credits folder runs on
 * credits and nothing else, and every other folder runs on the person's own
 * sign-in and never sees a credits token. A credits session that cannot have a
 * live token is refused before anything launches.
 *
 * The invariant at the bottom is the one the ADR promises: no turn's
 * environment ever carries `ANTHROPIC_AUTH_TOKEN` unless a real link credential
 * minted it for a session that chose credits.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };
import { InferenceTokenSchema } from '@dork-labs/cloud-api';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { __setCreditsStateForTests } from '../../../../core/cloud/credits-inference.js';
import { creditsClaudeRoot } from '../../credits-root.js';
import { resolveClaudeCredentialEnv } from '../../../../core/credential-env.js';

const link = vi.hoisted(() => ({ linked: true }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue({ text: '', stable: '' }),
  renderContextEntry: vi.fn(() => ''),
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
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined), onChange: vi.fn(() => () => {}) },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../../core/agent-identity/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/agent-identity/index.js')>()),
  resolveAgentTokenEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../../core/cloud/v1-client.js', () => ({
  isCloudLinked: () => link.linked,
  readCloudInstanceToken: () => (link.linked ? 'ik' : null),
  captureCloudV1Context: () => null,
  resolveCloudInstanceId: async () => null,
  problemOf: () => null,
}));

const token = InferenceTokenSchema.parse(tokenFixture);
const liveClock = () => Date.parse(token.expiresAt) - 60_000;

let dorkHome: string;

function makeSession(accountRoot?: string): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...(accountRoot !== undefined ? { accountRoot } : {}),
  };
}

const opts: MessageSenderOpts = { cwd: '/mock/project', onSdkSessionRebind: async () => {} };

/** Drive one turn; hand back what the SDK was launched with (or nothing) and the events. */
async function launch(
  session: AgentSession
): Promise<{ options: Options | undefined; events: StreamEvent[] }> {
  let options: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    options = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  const events: StreamEvent[] = [];
  for await (const event of executeSdkQuery('s1', 'hello', session, opts)) events.push(event);
  return { options, events };
}

describe('who pays for a Claude Code turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-launch-'));
    vi.stubEnv('DORK_HOME', dorkHome);
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
    link.linked = true;
    __setCreditsStateForTests({ token, now: liveClock });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __setCreditsStateForTests({ token: null });
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  it('runs a credits session on credits: the endpoint, the token, the credits folder', async () => {
    const { options } = await launch(makeSession(creditsClaudeRoot()));
    expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBe(token.token);
    expect(options?.env?.ANTHROPIC_BASE_URL).toBe(token.endpoints.anthropicMessages);
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(creditsClaudeRoot());
    // The folder exists as an account root, so its transcript is found again.
    expect(fs.existsSync(path.join(creditsClaudeRoot(), 'projects'))).toBe(true);
  });

  it('strips the person’s own key and every route around the endpoint from a credits turn', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-person-own');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-person-own');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    vi.mocked(resolveClaudeCredentialEnv).mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-stored' });
    const { options } = await launch(makeSession(creditsClaudeRoot()));
    const env = options?.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token.token);
    // The stored key is never even resolved for a credits turn.
    expect(resolveClaudeCredentialEnv).not.toHaveBeenCalled();
  });

  it('refuses a credits session with no live token, and launches nothing (fail closed)', async () => {
    __setCreditsStateForTests({ token: null });
    const { options, events } = await launch(makeSession(creditsClaudeRoot()));
    expect(query).not.toHaveBeenCalled();
    expect(options).toBeUndefined();
    expect(events).toEqual([
      {
        type: 'error',
        data: expect.objectContaining({
          code: 'credits_unavailable',
          message: expect.stringContaining("Couldn't reach DorkOS credits"),
        }),
      },
    ]);
  });

  it('refuses a credits session once this computer is unlinked, even with a token held', async () => {
    link.linked = false;
    const { events } = await launch(makeSession(creditsClaudeRoot()));
    expect(query).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'error', data: { code: 'credits_unavailable' } });
  });

  it('gives a session on its own sign-in no credits variable, whatever token is held', async () => {
    const own = path.join(dorkHome, 'own-claude');
    const { options } = await launch(makeSession(own));
    expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(JSON.stringify(options?.env)).not.toContain(token.token);
  });

  it('keeps the person’s own stored key on their own sign-in', async () => {
    vi.mocked(resolveClaudeCredentialEnv).mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-stored' });
    const { options } = await launch(makeSession(path.join(dorkHome, 'own-claude')));
    expect(options?.env?.ANTHROPIC_API_KEY).toBe('sk-stored');
  });
});

describe('the invariant: no ANTHROPIC_AUTH_TOKEN without a real link credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-invariant-'));
    vi.stubEnv('DORK_HOME', dorkHome);
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __setCreditsStateForTests({ token: null });
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  // Every combination of: which folder the session is on, whether this computer
  // is linked, and whether a token is held. The token may appear only on the
  // credits folder, linked, holding a token minted under that link.
  const folders = ['credits', 'own', 'ladder'] as const;
  for (const folder of folders) {
    for (const linked of [true, false]) {
      for (const held of [true, false]) {
        it(`${folder} folder, ${linked ? 'linked' : 'unlinked'}, ${held ? 'token held' : 'no token'}`, async () => {
          link.linked = linked;
          __setCreditsStateForTests({ token: held ? token : null, now: liveClock });
          const root =
            folder === 'credits'
              ? creditsClaudeRoot()
              : folder === 'own'
                ? path.join(dorkHome, 'own-claude')
                : undefined;
          const { options } = await launch(makeSession(root));
          const carried = options?.env?.ANTHROPIC_AUTH_TOKEN;
          const allowed = folder === 'credits' && linked && held;
          if (allowed) {
            expect(carried).toBe(token.token);
          } else {
            expect(carried).toBeUndefined();
          }
        });
      }
    }
  }
});
