import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { FakeAgentRuntime } from '@dorkos/test-utils';

// Mock the registry + createApp deps before importing the app.
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: { listRuntimes: vi.fn() },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();

/** Build a fake runtime whose checkDependencies yields the given checks. */
function fakeRuntime(type: string, deps: DependencyCheck[], delayMs = 0): FakeAgentRuntime {
  const runtime = new FakeAgentRuntime(type);
  runtime.checkDependencies.mockImplementation(
    () =>
      new Promise<DependencyCheck[]>((resolve) => {
        if (delayMs) setTimeout(() => resolve(deps), delayMs);
        else resolve(deps);
      })
  );
  return runtime;
}

const dep = (name: string, status: DependencyCheck['status']): DependencyCheck => ({
  name,
  description: `${name} description`,
  status,
});

describe('GET /api/system/requirements — Ready/Connect projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects state:ready with no connect when binary and auth are satisfied', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime('codex', [
        dep('Codex CLI', 'satisfied'),
        dep('Codex authentication', 'satisfied'),
      ]),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.status).toBe(200);
    expect(res.body.runtimes.codex.state).toBe('ready');
    expect(res.body.runtimes.codex.connect).toBeUndefined();
  });

  it('projects state:connect with kind:install when the binary is missing', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime('codex', [dep('Codex CLI', 'missing'), dep('Codex authentication', 'missing')]),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.body.runtimes.codex.state).toBe('connect');
    expect(res.body.runtimes.codex.connect).toEqual({ kind: 'install', label: 'Install Codex' });
  });

  it('projects state:connect with kind:login when the binary is present but auth is missing', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime('codex', [dep('Codex CLI', 'satisfied'), dep('Codex authentication', 'missing')]),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.body.runtimes.codex.state).toBe('connect');
    expect(res.body.runtimes.codex.connect).toEqual({ kind: 'login', label: 'Connect Codex' });
  });

  it('projects kind:provider-picker for OpenCode when auth is missing (provider-agnostic)', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime('opencode', [
        dep('OpenCode CLI', 'satisfied'),
        dep('OpenCode authentication', 'missing'),
      ]),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.body.runtimes.opencode.connect).toEqual({
      kind: 'provider-picker',
      label: 'Choose a model provider',
    });
  });

  it('treats a runtime that declares no auth check as Ready when the CLI is satisfied (legacy shape)', async () => {
    // Backward-compat for a single-dependency runtime shape: no auth check reads
    // as "auth not required". (Real Claude now ships an authentication check —
    // covered by the claude-code adapter tests — so a signed-out CLI no longer
    // slips through this default.)
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime('aider', [dep('Aider CLI', 'satisfied')]),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.body.runtimes['aider'].state).toBe('ready');
    expect(res.body.runtimes['aider'].connect).toBeUndefined();
  });

  it('projects a signed-out Claude (CLI satisfied, auth missing) to Connect with kind "login"', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime('claude-code', [
        dep('Claude Code CLI', 'satisfied'),
        dep('Claude Code authentication', 'missing'),
      ]),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.body.runtimes['claude-code'].state).toBe('connect');
    expect(res.body.runtimes['claude-code'].connect).toEqual({
      kind: 'login',
      label: 'Connect Claude',
    });
  });

  it('keeps the raw dependencies[] in the payload for every runtime', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime('codex', [dep('Codex CLI', 'satisfied'), dep('Codex authentication', 'missing')]),
      fakeRuntime('opencode', [
        dep('OpenCode CLI', 'missing'),
        dep('OpenCode authentication', 'missing'),
      ]),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.body.runtimes.codex.dependencies).toHaveLength(2);
    expect(res.body.runtimes.codex.dependencies[0].name).toBe('Codex CLI');
    expect(res.body.runtimes.opencode.dependencies).toHaveLength(2);
  });

  it('does not block on a slow probe — the handler still responds', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([
      fakeRuntime(
        'codex',
        [dep('Codex CLI', 'satisfied'), dep('Codex authentication', 'satisfied')],
        20
      ),
    ]);

    const res = await request(app).get('/api/system/requirements');

    expect(res.status).toBe(200);
    expect(res.body.runtimes.codex.state).toBe('ready');
  });
});
