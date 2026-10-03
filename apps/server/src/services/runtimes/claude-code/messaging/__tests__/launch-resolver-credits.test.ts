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
import { createCloudApiClient } from '@dork-labs/cloud-api/client';
import { __setCreditsStateForTests } from '../../../../core/cloud/credits-inference.js';
import { __resetCreditsModelsForTests } from '../../../../core/cloud/credits-models.js';
import { creditsClaudeRoot } from '../../credits-root.js';
import { resolveClaudeCredentialEnv } from '../../../../core/credential-env.js';
import { configManager } from '../../../../core/config-manager.js';

const link = vi.hoisted(() => ({ linked: true }));
// What the fake service's `GET /v1/inference/models` answers, or null for no link context.
const service = vi.hoisted(() => ({ list: null as unknown }));

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
  captureCloudV1Context: () =>
    service.list === null
      ? null
      : {
          client: createCloudApiClient({
            baseUrl: 'https://cloud.example.invalid',
            token: 'ik',
            fetch: async () =>
              new Response(JSON.stringify(service.list), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
          }),
          isCurrent: () => true,
        },
  resolveCloudInstanceId: async () => null,
  problemOf: () => null,
}));

const token = InferenceTokenSchema.parse(tokenFixture);
const liveClock = () => Date.parse(token.expiresAt) - 60 * 60_000;

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

/** Drive one turn; hand back what the SDK was launched with (or nothing) and the events. */
async function launch(
  session: AgentSession,
  cwd = '/mock/project'
): Promise<{ options: Options | undefined; events: StreamEvent[] }> {
  const opts: MessageSenderOpts = { cwd, onSdkSessionRebind: async () => {} };
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
    service.list = null;
    __resetCreditsModelsForTests();
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

  it('keeps the person’s inherit list on credits, but no key, route or backend credential survives', async () => {
    // Even names the person explicitly inherits: a credits turn keeps none that
    // route or pay, and every other one it keeps.
    vi.mocked(configManager.get).mockImplementation(((key: string) =>
      key === 'runtimes'
        ? {
            environment: {
              inherit: {
                claudeCode: [
                  'MY_TOOL_HOME',
                  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
                  'ANTHROPIC_AWS_API_KEY',
                  'CLAUDE_CODE_USE_GATEWAY',
                  'CLAUDE_CODE_USE_MANTLE',
                  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
                ],
              },
            },
          }
        : undefined) as never);
    vi.stubEnv('MY_TOOL_HOME', '/opt/tool');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-person-own');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-person-own');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'aws-own');
    vi.stubEnv('CLAUDE_CODE_USE_ANTHROPIC_AWS', '1');
    vi.stubEnv('ANTHROPIC_AWS_API_KEY', 'aws-api-own');
    vi.stubEnv('CLAUDE_CODE_USE_GATEWAY', '1');
    vi.stubEnv('CLAUDE_CODE_USE_MANTLE', '1');
    vi.stubEnv('CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', '1');
    vi.mocked(resolveClaudeCredentialEnv).mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-stored' });
    try {
      const { options } = await launch(makeSession(creditsClaudeRoot()));
      const env = options?.env ?? {};
      for (const name of Object.keys(env)) {
        expect(name, `${name} survived into a credits turn`).not.toMatch(
          /^(CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK|ANTHROPIC_API_KEY|ANTHROPIC_AWS|CLAUDE_CODE_OAUTH)/
        );
      }
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token.token);
      expect(env.MY_TOOL_HOME).toBe('/opt/tool');
      // And the launch's own settings blank every routing switch above a folder's.
      const settingsEnv = (options?.settings as { env?: Record<string, string> }).env ?? {};
      for (const name of [
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_ANTHROPIC_AWS',
        'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
        'CLAUDE_CODE_USE_MANTLE',
        'CLAUDE_CODE_USE_GATEWAY',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AWS_API_KEY',
      ]) {
        expect(settingsEnv[name], name).toBe('');
      }
      expect(settingsEnv.ANTHROPIC_BASE_URL).toBe(token.endpoints.anthropicMessages);
      // The token never rides the settings: they are passed on the command line.
      expect(JSON.stringify(options?.settings)).not.toContain(token.token);
      // The stored key is never even resolved for a credits turn.
      expect(resolveClaudeCredentialEnv).not.toHaveBeenCalled();
    } finally {
      vi.mocked(configManager.get).mockReturnValue(undefined as never);
    }
  });

  it('blanks only what a folder’s settings set to route or pay, and puts the server’s PATH back', async () => {
    const folder = path.join(dorkHome, 'folder');
    fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(folder, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'http://folder',
          ANTHROPIC_SOMETHING_NEW: 'x',
          AWS_PROFILE: 'folder',
          HTTPS_PROXY: 'http://folder-proxy',
          PATH: '/folder/bin',
          DATABASE_URL: 'postgres://folder',
          MAX_THINKING_TOKENS: '9',
        },
      })
    );
    const { options } = await launch(makeSession(creditsClaudeRoot()), folder);
    const settingsEnv = (options?.settings as { env?: Record<string, string> }).env ?? {};
    expect(settingsEnv.ANTHROPIC_BASE_URL).toBe(token.endpoints.anthropicMessages);
    expect(settingsEnv.ANTHROPIC_SOMETHING_NEW).toBe('');
    expect(settingsEnv).not.toHaveProperty('AWS_PROFILE');
    expect(settingsEnv.HTTPS_PROXY).toBe(options?.env?.HTTPS_PROXY ?? '');
    expect(settingsEnv.PATH).toBe(options?.env?.PATH);
    expect(settingsEnv.PATH).toBeTruthy();
    expect(settingsEnv).not.toHaveProperty('DATABASE_URL');
    expect(settingsEnv).not.toHaveProperty('MAX_THINKING_TOKENS');
  });

  it.each([
    ['its own token', { env: { ANTHROPIC_AUTH_TOKEN: 'folder-token' } }],
    ['a key helper', { apiKeyHelper: 'echo folder-key' }],
  ])('refuses a credits turn in a folder whose settings name %s', async (_name, settings) => {
    const folder = path.join(dorkHome, 'signed-folder');
    fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude', 'settings.local.json'), JSON.stringify(settings));
    const { events } = await launch(makeSession(creditsClaudeRoot()), folder);
    expect(query).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'error',
      data: {
        code: 'credits_unavailable',
        reason: 'folder-sign-in',
        message: expect.stringContaining('name their own sign-in'),
      },
    });
  });

  it('gives a turn on the person’s own sign-in no flag settings env at all', async () => {
    const { options } = await launch(makeSession(path.join(dorkHome, 'own-claude')));
    expect((options?.settings as { env?: unknown } | undefined)?.env).toBeUndefined();
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

  describe('the model a credits session runs (DOR-2636)', () => {
    const supports = { tools: true, promptCaching: true, streaming: true, thinking: true };
    const SAYS_PROTOCOLS = {
      catalogVersion: 'cv_1',
      models: [
        {
          id: 'md_suggested',
          displayName: 'Suggested',
          contextWindow: 200000,
          maxOutputTokens: 64000,
          supports,
          protocols: ['anthropic-messages'],
          recommendedOn: ['anthropic-messages'],
        },
        {
          id: 'md_served',
          displayName: 'Served',
          contextWindow: 200000,
          maxOutputTokens: 64000,
          supports,
          protocols: ['anthropic-messages'],
        },
      ],
    };
    /** A service older than the `protocols` field. */
    const SAYS_NOTHING = {
      catalogVersion: 'cv_0',
      models: [{ ...SAYS_PROTOCOLS.models[1], protocols: undefined }],
    };
    const notices = (events: StreamEvent[]) =>
      events.filter(
        (event) =>
          event.type === 'system_status' &&
          String((event.data as { message?: string }).message).includes(
            "DorkOS credits don't cover"
          )
      );

    it('starts a session nobody chose a model for on the service’s suggestion', async () => {
      service.list = SAYS_PROTOCOLS;
      const { options } = await launch(makeSession(creditsClaudeRoot()));
      expect(options?.model).toBe('md_suggested');
    });

    it('keeps a model credits serve', async () => {
      service.list = SAYS_PROTOCOLS;
      const { options, events } = await launch({
        ...makeSession(creditsClaudeRoot()),
        model: 'md_served',
      });
      expect(options?.model).toBe('md_served');
      expect(notices(events)).toHaveLength(0);
    });

    it('runs a pinned model credits do not serve on the suggestion, and says so once', async () => {
      service.list = SAYS_PROTOCOLS;
      const pinned = { ...makeSession(creditsClaudeRoot()), model: 'claude-opus-4-6' };
      const first = await launch(pinned);
      expect(first.options?.model).toBe('md_suggested');
      expect(notices(first.events)).toEqual([
        {
          type: 'system_status',
          data: {
            message:
              "DorkOS credits don't cover claude-opus-4-6, so this chat runs on Suggested. Pick another model from the model menu.",
          },
        },
      ]);
      const second = await launch(pinned);
      expect(second.options?.model).toBe('md_suggested');
      expect(notices(second.events)).toHaveLength(0);
    });

    it('changes nothing while the service says nothing about protocols, or cannot be read', async () => {
      service.list = SAYS_NOTHING;
      const pinned = { ...makeSession(creditsClaudeRoot()), model: 'claude-opus-4-6' };
      expect((await launch(pinned)).options?.model).toBe('claude-opus-4-6');
      expect((await launch(makeSession(creditsClaudeRoot()))).options?.model).toBeUndefined();
      __resetCreditsModelsForTests();
      service.list = null;
      expect((await launch(pinned)).options?.model).toBe('claude-opus-4-6');
    });

    it('never touches the model of a session on its own sign-in', async () => {
      service.list = SAYS_PROTOCOLS;
      const own = { ...makeSession(path.join(dorkHome, 'own-claude')), model: 'claude-opus-4-6' };
      const { options, events } = await launch(own);
      expect(options?.model).toBe('claude-opus-4-6');
      expect(notices(events)).toHaveLength(0);
      expect(
        (await launch(makeSession(path.join(dorkHome, 'own-claude')))).options?.model
      ).toBeUndefined();
    });
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
