import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock runtime registry before any imports that use it
const mockCapabilities = {
  type: 'claude-code',
  supportsPermissionModes: true,
  supportedPermissionModes: ['default', 'plan', 'acceptEdits', 'bypassPermissions'],
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsQuestionPrompt: true,
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
      updateSession: vi.fn(() => true),
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

import request from 'supertest';
import { createApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

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
      supportsPermissionModes: false,
      supportsToolApproval: false,
      supportsCostTracking: false,
      supportsResume: false,
      supportsMcp: false,
      supportsQuestionPrompt: false,
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
});
