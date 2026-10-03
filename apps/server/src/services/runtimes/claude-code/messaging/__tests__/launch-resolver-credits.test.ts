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
import type { ModelOption, StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
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
  cwd = '/mock/project',
  extra: Partial<MessageSenderOpts> = {},
  messageOpts?: MessageOpts
): Promise<{ options: Options | undefined; events: StreamEvent[] }> {
  const opts: MessageSenderOpts = { cwd, onSdkSessionRebind: async () => {}, ...extra };
  let options: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    options = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  const events: StreamEvent[] = [];
  for await (const event of executeSdkQuery('s1', 'hello', session, opts, messageOpts)) {
    events.push(event);
  }
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
          id: 'claude-sonnet-wire',
          displayName: 'Served Sonnet',
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
    /** Claude Code's own catalog: its aliases and what each expands to. */
    const CATALOG: Record<string, ModelOption> = {
      default: {
        value: 'default',
        displayName: 'Default (Opus)',
        description: '',
        resolvedModel: 'claude-opus-wire',
        supportsFastMode: true,
      },
      opus: {
        value: 'opus',
        displayName: 'Opus',
        description: '',
        resolvedModel: 'claude-opus-wire',
        supportsFastMode: true,
      },
      sonnet: {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: '',
        resolvedModel: 'claude-sonnet-wire',
      },
      haiku: {
        value: 'haiku',
        displayName: 'Haiku',
        description: '',
        resolvedModel: 'claude-haiku-wire',
      },
      md_suggested: {
        value: 'md_suggested',
        displayName: 'Suggested',
        description: '',
        supportsEffort: true,
        supportsAutoMode: false,
        supportsFastMode: false,
      },
    };
    const lookupModel = (value: string | undefined) => CATALOG[value ?? 'default'];
    const substitutions = (events: StreamEvent[]) =>
      events.filter((event) => event.type === 'model_substituted');
    let remembered: string[];
    const withCatalog = (): Partial<MessageSenderOpts> => ({
      lookupModel,
      rememberSessionModel: async (model) => {
        remembered.push(model);
      },
    });
    beforeEach(() => {
      remembered = [];
    });

    it('starts a session nobody chose a model for on the suggestion, with its capability', async () => {
      service.list = SAYS_PROTOCOLS;
      const { options } = await launch(makeSession(creditsClaudeRoot()), undefined, withCatalog());
      expect(options?.model).toBe('md_suggested');
      expect(remembered).toEqual([]);
    });

    it('keeps an alias whose resolved model credits serve, and a served id', async () => {
      service.list = SAYS_PROTOCOLS;
      for (const model of ['sonnet', 'claude-sonnet-wire']) {
        const { options, events } = await launch(
          { ...makeSession(creditsClaudeRoot()), model },
          undefined,
          withCatalog()
        );
        expect(options?.model).toBe(model);
        expect(substitutions(events)).toHaveLength(0);
      }
    });

    it.each(['default', 'opus', 'haiku'])(
      'runs the alias %s, which credits do not serve, on the suggestion and records it by name',
      async (alias) => {
        service.list = SAYS_PROTOCOLS;
        const session = {
          ...makeSession(creditsClaudeRoot()),
          sdkSessionId: `sdk-${alias}`,
          model: alias,
        };
        const { options, events } = await launch(session, undefined, withCatalog());
        expect(options?.model).toBe('md_suggested');
        expect(substitutions(events)).toEqual([
          {
            type: 'model_substituted',
            data: {
              from: alias,
              fromName: CATALOG[alias]!.displayName,
              to: 'md_suggested',
              toName: 'Suggested',
              reason: 'credits-not-covered',
            },
          },
        ]);
        // The model that ran becomes the session's own, so the status line shows it.
        expect(remembered).toEqual(['md_suggested']);
      }
    );

    it('launches the swap with the capability of the model that runs: no fast mode it cannot take', async () => {
      service.list = SAYS_PROTOCOLS;
      const session = { ...makeSession(creditsClaudeRoot()), model: 'opus', fastMode: true };
      const { options } = await launch(session, undefined, withCatalog());
      expect(options?.model).toBe('md_suggested');
      expect((options?.settings as { fastMode?: boolean } | undefined)?.fastMode).toBeUndefined();
    });

    it('judges auto mode by the model that runs, not the one it replaced', async () => {
      service.list = SAYS_PROTOCOLS;
      const session = {
        ...makeSession(creditsClaudeRoot()),
        model: 'haiku',
        permissionMode: 'auto' as const,
      };
      // The named model would take auto mode; the one credits run cannot.
      const { options } = await launch(session, undefined, {
        ...withCatalog(),
        modelSupportsAutoMode: true,
      });
      expect(options?.model).toBe('md_suggested');
      expect(options?.permissionMode).toBe('default');
    });

    it('saves and marks nothing for a launch refused after the swap, so the next one says it', async () => {
      service.list = SAYS_PROTOCOLS;
      const session = {
        ...makeSession(creditsClaudeRoot()),
        // A model no other case names: the told-once memory spans this file.
        model: 'claude-never-named-elsewhere',
      };
      // A folder grant Claude Code cannot keep read-only refuses the launch
      // AFTER the model was decided, before any status event goes out.
      await expect(
        launch(session, undefined, withCatalog(), {
          additionalDirectories: [{ path: '/work/odd?name', access: 'read' }],
        } as MessageOpts)
      ).rejects.toThrow();
      expect(remembered).toEqual([]);

      const next = await launch(session, undefined, withCatalog());
      expect(substitutions(next.events)).toHaveLength(1);
      expect(remembered).toEqual(['md_suggested']);
    });

    it('records the swap once per session and model', async () => {
      service.list = SAYS_PROTOCOLS;
      const session = { ...makeSession(creditsClaudeRoot()), model: 'claude-opus-4-6' };
      const opts = { ...withCatalog(), rememberSessionModel: async () => {} };
      expect(substitutions((await launch(session, undefined, opts)).events)).toHaveLength(1);
      expect(substitutions((await launch(session, undefined, opts)).events)).toHaveLength(0);
    });

    it('refuses plainly when the service names protocols but none for Claude Code', async () => {
      service.list = {
        catalogVersion: 'cv',
        models: [{ ...SAYS_PROTOCOLS.models[0], protocols: ['openai-chat'], recommendedOn: [] }],
      };
      const { events } = await launch(makeSession(creditsClaudeRoot()), undefined, withCatalog());
      expect(query).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({
        type: 'error',
        data: {
          code: 'credits_unavailable',
          reason: 'no-models',
          message:
            'DorkOS credits don’t cover a Claude Code model yet, so nothing was sent. Use your Claude Code sign-in instead.',
        },
      });
    });

    it('changes nothing while the service says nothing about protocols, or cannot be read', async () => {
      service.list = SAYS_NOTHING;
      const pinned = { ...makeSession(creditsClaudeRoot()), model: 'opus' };
      expect((await launch(pinned, undefined, withCatalog())).options?.model).toBe('opus');
      expect(
        (await launch(makeSession(creditsClaudeRoot()), undefined, withCatalog())).options?.model
      ).toBeUndefined();
      __resetCreditsModelsForTests();
      service.list = null;
      expect((await launch(pinned, undefined, withCatalog())).options?.model).toBe('opus');
    });

    it('never touches the model of a session on its own sign-in', async () => {
      service.list = SAYS_PROTOCOLS;
      const own = { ...makeSession(path.join(dorkHome, 'own-claude')), model: 'opus' };
      const { options, events } = await launch(own, undefined, withCatalog());
      expect(options?.model).toBe('opus');
      expect(substitutions(events)).toHaveLength(0);
      expect(remembered).toEqual([]);
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
