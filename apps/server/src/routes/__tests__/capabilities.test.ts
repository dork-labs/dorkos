import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock runtime registry before any imports that use it
const mockCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  permissionModes: {
    supported: true,
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks first.',
      },
      { id: 'plan', label: 'Plan', stop: 'ask', asks: 'always', reach: 'read', promise: 'Plans.' },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits on its own.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking.',
      },
    ],
  },
  settings: {
    configSection: 'claudeCode',
    supportsEffort: true,
    sections: [{ kind: 'claude-accounts' }],
  },
  features: {},
};

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getAllCapabilities: vi.fn(() => ({
      'claude-code': mockCapabilities,
    })),
    getDefaultType: vi.fn(() => 'claude-code'),
    getDefault: vi.fn(() => ({
      ensureSession: vi.fn(),
      sendMessage: vi.fn(),
      approveTool: vi.fn(),
      hasSession: vi.fn(),
      checkSessionHealth: vi.fn(),
      getInternalSessionId: vi.fn(),
      getSupportedModels: vi.fn(async () => []),
      getCapabilities: vi.fn(() => mockCapabilities),
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(async () => null),
      getMessageHistory: vi.fn(async () => []),
      getSessionTasks: vi.fn(async () => []),
      getSessionETag: vi.fn(async () => null),
      readFromOffset: vi.fn(async () => ({ content: '', newOffset: 0 })),
      acquireLock: vi.fn(() => true),
      releaseLock: vi.fn(),
      isLocked: vi.fn(() => false),
      getLockInfo: vi.fn(() => null),
      updateSession: vi.fn(() => ({ updated: true })),
      submitAnswers: vi.fn(() => true),
      getCommands: vi.fn(async () => ({ commands: [], lastScanned: '' })),
    })),
  },
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
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../../services/runtimes/test-mode/runtime-constants.js';

const app = createApp();

describe('Capabilities Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/capabilities returns capabilities and defaultRuntime', async () => {
    const res = await request(app).get('/api/capabilities');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('capabilities');
    expect(res.body).toHaveProperty('defaultRuntime');
    expect(res.body.defaultRuntime).toBe('claude-code');
    expect(res.body.capabilities).toHaveProperty('claude-code');
    expect(res.body.capabilities['claude-code']).toEqual(mockCapabilities);
  });

  it('calls runtimeRegistry.getAllCapabilities and getDefaultType', async () => {
    await request(app).get('/api/capabilities');

    expect(runtimeRegistry.getAllCapabilities).toHaveBeenCalledOnce();
    expect(runtimeRegistry.getDefaultType).toHaveBeenCalledOnce();
  });

  it('returns empty capabilities when no runtimes are registered', async () => {
    vi.mocked(runtimeRegistry.getAllCapabilities).mockReturnValueOnce({});
    vi.mocked(runtimeRegistry.getDefaultType).mockReturnValueOnce('claude-code');

    const res = await request(app).get('/api/capabilities');

    expect(res.status).toBe(200);
    expect(res.body.capabilities).toEqual({});
    expect(res.body.defaultRuntime).toBe('claude-code');
  });

  it('returns capabilities for multiple runtimes', async () => {
    const opencodeCapabilities = {
      type: 'opencode',
      supportsToolApproval: false,
      supportsCostTracking: false,
      supportsResume: false,
      supportsMcp: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      permissionModes: { supported: false, values: [] },
      settings: {
        configSection: 'opencode',
        supportsEffort: false,
        sections: [{ kind: 'opencode-power-source' }],
      },
      features: {},
    };

    vi.mocked(runtimeRegistry.getAllCapabilities).mockReturnValueOnce({
      'claude-code': mockCapabilities,
      opencode: opencodeCapabilities,
    });

    const res = await request(app).get('/api/capabilities');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.capabilities)).toHaveLength(2);
    expect(res.body.capabilities['claude-code'].supportsToolApproval).toBe(true);
    expect(res.body.capabilities['opencode'].supportsToolApproval).toBe(false);
  });

  it('projects each runtime own settings declaration onto the wire', async () => {
    // Pins the REAL adapter constants, not a fixture: a runtime that forgets its
    // config section, or points at the wrong one, fails here rather than at the
    // settings screen. test-mode is the null case — a real runtime with no
    // section under `runtimes.*`.
    vi.mocked(runtimeRegistry.getAllCapabilities).mockReturnValueOnce({
      'claude-code': CLAUDE_CODE_CAPABILITIES,
      'test-mode': TEST_MODE_CAPABILITIES,
    });

    const res = await request(app).get('/api/capabilities');

    expect(res.status).toBe(200);
    expect(res.body.capabilities['claude-code'].settings).toEqual({
      configSection: 'claudeCode',
      supportsEffort: true,
      sections: [{ kind: 'claude-accounts' }],
    });
    expect(res.body.capabilities['test-mode'].settings.configSection).toBeNull();
    expect(res.body.capabilities['test-mode'].settings.sections).toEqual([]);
  });
});
