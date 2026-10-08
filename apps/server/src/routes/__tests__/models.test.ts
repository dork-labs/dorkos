import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock boundary before importing app
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

// Per-runtime models: each runtime reports a distinct set, so a test that
// exercises routing asserts which runtime was selected.
const claudeModels = [
  {
    value: 'claude-sonnet-4-5-20250929',
    displayName: 'Sonnet 4.5',
    description: 'Claude default model',
  },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Claude high-capability' },
];
const testModeModels = [
  { value: 'test-mode-deterministic', displayName: 'Deterministic', description: 'Test runtime' },
];
const codexModels = [
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Codex flagship' },
  { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'Coding-optimized' },
];

// Which account the claude-code ladder says a session launches on.
const ladder = vi.hoisted(() => ({ accountId: 'default' }));
// The fake service behind `GET /v1/inference/models`.
const service = vi.hoisted(() => ({
  status: 200,
  calls: 0,
  body: {
    catalogVersion: 'cv_1',
    models: [
      {
        id: 'md_claude_pick',
        displayName: 'The service’s pick',
        contextWindow: 200000,
        maxOutputTokens: 64000,
        supports: { tools: true, promptCaching: true, streaming: true, thinking: true },
        protocols: ['anthropicMessages'],
        recommendedOn: ['anthropicMessages'],
      },
      {
        id: 'md_gpt_like',
        displayName: 'Offered only on the other protocol',
        contextWindow: 128000,
        maxOutputTokens: 16000,
        supports: { tools: true, promptCaching: false, streaming: true, thinking: false },
        protocols: ['openaiChat'],
      },
    ],
  } as unknown,
}));
vi.mock('../../services/core/cloud/v1-client.js', async (importOriginal) => {
  const { createCloudApiClient } = await import('@dork-labs/cloud-api/client');
  return {
    ...(await importOriginal<typeof import('../../services/core/cloud/v1-client.js')>()),
    readCloudInstanceToken: () => 'ik',
    captureCloudV1Context: () => ({
      client: createCloudApiClient({
        baseUrl: 'https://cloud.example.invalid',
        token: 'ik',
        fetch: async () => {
          service.calls += 1;
          return new Response(JSON.stringify(service.body), {
            status: service.status,
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
      isCurrent: () => true,
    }),
  };
});

const claudeRuntime = {
  type: 'claude-code',
  getSupportedModels: vi.fn(async () => claudeModels),
  getCapabilities: () => ({ credits: { protocol: 'anthropic-messages', scope: 'conversation' } }),
  checkLaunchAccount: vi.fn(async (_sessionId: string, _dir: string, hintId?: string) => ({
    ok: true,
    root: '/accounts/x',
    accountId: hintId ?? ladder.accountId,
  })),
};
const testModeRuntime = {
  type: 'test-mode',
  getSupportedModels: vi.fn(async () => testModeModels),
  getCapabilities: () => ({}),
};
const codexRuntime = {
  type: 'codex',
  getSupportedModels: vi.fn(async () => codexModels),
  getCapabilities: () => ({}),
};

const RUNTIMES: Record<
  string,
  { type: string; getSupportedModels: () => Promise<unknown>; getCapabilities: () => object }
> = {
  'claude-code': claudeRuntime,
  'test-mode': testModeRuntime,
  codex: codexRuntime,
};

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
const TEST_MODE_SESSION = '22222222-2222-4222-8222-222222222222';
// A brand-new session with no `session_metadata` row: resolveForSession would
// INFER claude-code for it, so an explicit `?runtime=` is the only correct path.
const ROWLESS_SESSION = '33333333-3333-4333-8333-333333333333';

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getNativeSessionCwd: vi.fn(() => null),
    getDefault: vi.fn(() => claudeRuntime),
    getDefaultType: vi.fn(() => 'claude-code'),
    getAllCapabilities: vi.fn(() => ({})),
    has: vi.fn((type: string) => type in RUNTIMES),
    get: vi.fn((type: string) => RUNTIMES[type]),
    // Row-less sessions infer claude-code (the production behavior we must NOT
    // rely on when the caller knows the runtime).
    resolveForSession: vi.fn(async (sessionId: string) => {
      if (sessionId === TEST_MODE_SESSION) return testModeRuntime;
      return claudeRuntime;
    }),
    getSessionAgentPath: vi.fn(async () => null),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { __resetCreditsModelsForTests } from '../../services/core/cloud/credits-models.js';
import fs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

/** Where these tests keep the credits list: never the dev data folder. */
const CREDITS_STORE = nodePath.join(
  nodeOs.tmpdir(),
  `credits-models-${process.pid}-${Math.random().toString(36).slice(2)}.json`
);

const app = createApp({ admission: new MainRequestAdmission() });
const testServer = listeningServer(app);

describe('Models Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ladder.accountId = 'default';
    service.status = 200;
    service.calls = 0;
    fs.rmSync(CREDITS_STORE, { force: true });
    __resetCreditsModelsForTests({ storePath: CREDITS_STORE });
  });

  it('GET /api/models with no sessionId falls back to default runtime (cold discovery)', async () => {
    const res = await request(testServer).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(claudeModels);
    expect(runtimeRegistry.getDefault).toHaveBeenCalledOnce();
    expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
  });

  it('GET /api/models?sessionId=<claude-session> resolves the claude-code runtime', async () => {
    const res = await request(testServer).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(claudeModels);
    expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(CLAUDE_SESSION);
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });

  it('GET /api/models?sessionId=<test-mode-session> resolves the test-mode runtime', async () => {
    const res = await request(testServer).get(`/api/models?sessionId=${TEST_MODE_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(testModeModels);
    expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(TEST_MODE_SESSION);
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });

  it('GET /api/models?runtime=codex returns the codex catalog without inferring from the session', async () => {
    // A row-less Codex session: `resolveForSession` would infer claude-code and
    // wrongly return Anthropic models. The explicit `runtime` param must win and
    // short-circuit session resolution entirely.
    const res = await request(testServer).get(
      `/api/models?runtime=codex&sessionId=${ROWLESS_SESSION}`
    );
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(codexModels);
    expect(runtimeRegistry.get).toHaveBeenCalledWith('codex');
    expect(runtimeRegistry.resolveForSession).not.toHaveBeenCalled();
    expect(runtimeRegistry.getDefault).not.toHaveBeenCalled();
  });

  it('GET /api/models?runtime=<unknown> returns 400', async () => {
    const res = await request(testServer).get('/api/models?runtime=bogus-runtime');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown runtime/i);
    expect(runtimeRegistry.get).not.toHaveBeenCalled();
  });

  describe('on DorkOS credits', () => {
    it.each(['openai-chat-completions', 'openai-responses'] as const)(
      'uses the frozen %s protocol for a Doe conversation menu',
      async (protocol) => {
        const wire = protocol === 'openai-responses' ? 'openaiResponses' : 'openaiChat';
        (service.body as { models: Array<{ protocols: string[] }> }).models[1].protocols = [wire];
        const runtime = {
          type: 'doe',
          getSupportedModels: async () => [],
          getCapabilities: () => ({
            type: 'doe',
            credits: {
              protocol: 'anthropic-messages',
              scope: 'conversation',
              supportedProtocols: [
                'anthropic-messages',
                'openai-chat-completions',
                'openai-responses',
              ],
            },
          }),
          getCreditsProtocol: (id?: string) =>
            id === ROWLESS_SESSION ? protocol : 'anthropic-messages',
          sessionRunsOnCredits: async () => true,
        };
        RUNTIMES.doe = runtime;
        try {
          const res = await request(testServer).get(
            `/api/models?runtime=doe&sessionId=${ROWLESS_SESSION}`
          );
          expect(res.status).toBe(200);
          expect(res.body.models.map((m: { value: string }) => m.value)).toEqual(['md_gpt_like']);
        } finally {
          delete RUNTIMES.doe;
        }
      }
    );

    it('lists only what credits serve on the runtime’s protocol for a session on credits', async () => {
      ladder.accountId = 'dorkos-credits';
      const res = await request(testServer).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
      expect(res.status).toBe(200);
      // No model offered only on the other protocol, none of Claude Code's own.
      expect(res.body.models).toEqual([
        expect.objectContaining({
          value: 'md_claude_pick',
          displayName: 'The service’s pick',
          isDefault: true,
        }),
      ]);
      expect(claudeRuntime.getSupportedModels).not.toHaveBeenCalled();
    });

    it('follows the person’s pick for a session that has not started', async () => {
      const onCredits = await request(testServer).get(
        `/api/models?runtime=claude-code&sessionId=${ROWLESS_SESSION}&account=dorkos-credits`
      );
      expect(onCredits.body.models.map((m: { value: string }) => m.value)).toEqual([
        'md_claude_pick',
      ]);
      expect(claudeRuntime.checkLaunchAccount).toHaveBeenCalledWith(
        ROWLESS_SESSION,
        expect.any(String),
        'dorkos-credits'
      );
      ladder.accountId = 'dorkos-credits';
      const ownPick = await request(testServer).get(
        `/api/models?runtime=claude-code&sessionId=${ROWLESS_SESSION}&account=work`
      );
      expect(ownPick.body.models).toEqual(claudeModels);
    });

    it('keeps the runtime’s own menu for a session on its own sign-in', async () => {
      const res = await request(testServer).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
      expect(res.body.models).toEqual(claudeModels);
      expect(service.calls).toBe(0);
    });

    it('answers credits directly with no session, and the own menu without the account', async () => {
      const credits = await request(testServer).get(
        '/api/models?runtime=claude-code&account=dorkos-credits'
      );
      expect(credits.body.models.map((m: { value: string }) => m.value)).toEqual([
        'md_claude_pick',
      ]);
      // The runtime-wide menu (Settings) is every sign-in's, so it stays the
      // runtime's own even while credits are the machine default.
      ladder.accountId = 'dorkos-credits';
      const own = await request(testServer).get('/api/models?runtime=claude-code');
      expect(own.body.models).toEqual(claudeModels);
    });

    it('answers the last good list, marked out of date, when the service cannot be read', async () => {
      ladder.accountId = 'dorkos-credits';
      let clock = 0;
      __resetCreditsModelsForTests({ now: () => clock, storePath: CREDITS_STORE });
      await request(testServer).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
      clock += 6 * 60_000;
      service.status = 500;
      const res = await request(testServer).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
      expect(res.status).toBe(200);
      expect(res.body.models).toEqual([
        expect.objectContaining({ value: 'md_claude_pick', creditsListOutOfDate: true }),
      ]);
      expect(claudeRuntime.getSupportedModels).not.toHaveBeenCalled();
    });

    it('keeps the runtime’s own menu while the service says nothing about protocols', async () => {
      ladder.accountId = 'dorkos-credits';
      const saved = service.body;
      service.body = {
        catalogVersion: 'cv_0',
        models: (saved as { models: Record<string, unknown>[] }).models.map(
          ({ protocols: _p, recommendedOn: _r, ...rest }) => rest
        ),
      };
      try {
        const res = await request(testServer).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
        expect(res.status).toBe(200);
        expect(res.body.models).toEqual(claudeModels);
      } finally {
        service.body = saved;
      }
    });

    it('keeps the runtime’s own menu when the list cannot be read and the service never said', async () => {
      ladder.accountId = 'dorkos-credits';
      service.status = 500;
      const res = await request(testServer).get(`/api/models?sessionId=${CLAUDE_SESSION}`);
      expect(res.status).toBe(200);
      expect(res.body.models).toEqual(claudeModels);
    });

    it('never treats a runtime that declares no credits protocol as on credits', async () => {
      const res = await request(testServer).get('/api/models?runtime=codex&account=dorkos-credits');
      expect(res.body.models).toEqual(codexModels);
      expect(service.calls).toBe(0);
    });
  });
});
