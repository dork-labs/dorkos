import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock tunnel-manager and agent-manager to avoid side effects
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null },
  },
}));

vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: () => '/usr/local/bin/claude',
  createHeldUserPrompt: vi.fn(() => ({ prompt: (async function* () {})(), close: vi.fn() })),
}));

vi.mock('../../lib/boundary.js', () => ({
  getBoundary: () => '/Users/test-user',
}));

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-route-test-'));
}

describe('PATCH /api/config', () => {
  let app: express.Express;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    // Initialize config manager before importing routes
    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns 200 with merged config for valid partial update', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.ui.theme).toBe('dark');
    // Other values should remain default
    expect(response.body.config.server.port).toBe(4242);
  });

  it('returns 400 with Zod errors for invalid port value', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ server: { port: 80 } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
    expect(response.body.details).toBeDefined();
    expect(response.body.details.length).toBeGreaterThan(0);
    expect(response.body.details[0]).toContain('server.port');
  });

  it('includes warning for sensitive key', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ tunnel: { authtoken: 'my-secret-token' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings[0]).toContain('sensitive data');
  });

  it('includes warning for the sensitive cloud.instanceToken key', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ cloud: { instanceToken: 'dork_inst_secret' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings.some((w: string) => w.includes('cloud.instanceToken'))).toBe(
      true
    );
  });

  it('returns 200 for empty object body (no-op)', async () => {
    const response = await request(app).patch('/api/config').send({}).expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.server.port).toBe(4242);
  });

  it('returns 400 for array body', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send([{ server: { port: 5000 } }])
      .expect(400);

    expect(response.body.error).toContain('JSON object');
  });

  it('persists changes across reads', async () => {
    await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    // Re-import to verify persistence
    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.getDot('ui.theme')).toBe('dark');
  });

  it('lets a person turn login on and off (the cockpit path)', async () => {
    // DOR-488: the agent-facing `config_patch` capability refuses posture-bearing
    // settings, but the guard sits at the CAPABILITY HANDLER, not inside the
    // shared `applyConfigPatch`. This route is what the cockpit's own enable-login
    // (`OwnerSetupHost.tsx`) and disable-login (`SecurityPanel.tsx`) flows call, so
    // if it ever starts refusing, a person can no longer turn login on at all.
    const { configManager } = await import('../../services/core/config-manager.js');

    const enabled = await request(app)
      .patch('/api/config')
      .send({ auth: { enabled: true } })
      .expect(200);
    expect(enabled.body.success).toBe(true);
    expect(enabled.body.config.auth.enabled).toBe(true);
    expect(configManager.getDot('auth.enabled')).toBe(true);

    const disabled = await request(app)
      .patch('/api/config')
      .send({ auth: { enabled: false } })
      .expect(200);
    expect(disabled.body.success).toBe(true);
    expect(configManager.getDot('auth.enabled')).toBe(false);
  });

  it('lets a person change the other operator-only settings too', async () => {
    // The rest of the write allowlist, proven not to have leaked onto the human
    // path: exposure, the MCP endpoint's key, telemetry consent, and the boundary.
    const response = await request(app)
      .patch('/api/config')
      .send({
        tunnel: { enabled: true },
        mcp: { apiKey: 'chosen-by-a-person' },
        telemetry: { usage: false },
        server: { boundary: '/Users/test-user' },
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.tunnel.enabled).toBe(true);
    expect(response.body.config.telemetry.usage).toBe(false);
    expect(response.body.config.server.boundary).toBe('/Users/test-user');
  });

  it('returns 400 for invalid theme value', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ ui: { theme: 'invalid-theme' } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });

  it('deep merges nested config objects', async () => {
    // First set port to 5000
    await request(app)
      .patch('/api/config')
      .send({ server: { port: 5000 } })
      .expect(200);

    // Then set cwd, port should remain 5000
    const response = await request(app)
      .patch('/api/config')
      .send({ server: { cwd: '/test' } })
      .expect(200);

    expect(response.body.config.server.port).toBe(5000);
    expect(response.body.config.server.cwd).toBe('/test');
  });

  it('warns for multiple sensitive keys', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({
        tunnel: {
          authtoken: 'token',
          auth: 'user:pass',
        },
      })
      .expect(200);

    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings.length).toBe(2);
  });

  it('validates port range correctly', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({ server: { port: 70000 } })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
  });
});

describe('GET /api/config', () => {
  let app: express.Express;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('includes boundary field in response', async () => {
    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('boundary');
    expect(typeof res.body.boundary).toBe('string');
    expect(res.body.boundary).toBe('/Users/test-user');
  });

  it('includes existing config fields alongside boundary', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('workingDirectory');
    expect(res.body).toHaveProperty('boundary');
    expect(res.body).toHaveProperty('tunnel');
    expect(res.body).toHaveProperty('tasks');
    expect(res.body).toHaveProperty('relay');
    expect(res.body).toHaveProperty('mesh');
  });

  it('includes ui.sidebar organization prefs (DOR-329)', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.ui.sidebar).toBeDefined();
    expect(Array.isArray(res.body.ui.sidebar.pinned)).toBe(true);
    expect(Array.isArray(res.body.ui.sidebar.groups)).toBe(true);
    expect(res.body.ui.sidebar.ungroupedSortMode).toBe('name');
  });

  it('includes ui.shapes state (DOR-355)', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.ui.shapes).toBeDefined();
    expect(res.body.ui.shapes.active).toBeNull();
    expect(res.body.ui.shapes.agentDefaults).toEqual({});
    expect(res.body.ui.shapes.autoFollowAgent).toBe(false);
  });

  it('includes ui.statusBar pins, nothing pinned by default (DOR-431, DOR-452)', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.ui.statusBar).toBeDefined();
    expect(res.body.ui.statusBar).toEqual({ pins: [] });
  });
});

describe('PUT /api/config/agents/defaultAgent', () => {
  let app: express.Express;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = createTempDir();
    process.env.DORK_HOME = tmpDir;

    const { initConfigManager } = await import('../../services/core/config-manager.js');
    initConfigManager(tmpDir);

    const configRouter = (await import('../config.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('sets the default agent and returns success', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 'my-agent' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.defaultAgent).toBe('my-agent');
  });

  it('persists the default agent in config', async () => {
    await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 'my-agent' })
      .expect(200);

    const { configManager } = await import('../../services/core/config-manager.js');
    expect(configManager.get('agents')?.defaultAgent).toBe('my-agent');
  });

  it('returns 400 when value is missing', async () => {
    const res = await request(app).put('/api/config/agents/defaultAgent').send({}).expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('returns 400 when value is empty string', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: '  ' })
      .expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('returns 400 when value is not a string', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: 123 })
      .expect(400);

    expect(res.body.error).toContain('non-empty');
  });

  it('trims whitespace from agent name', async () => {
    const res = await request(app)
      .put('/api/config/agents/defaultAgent')
      .send({ value: '  my-agent  ' })
      .expect(200);

    expect(res.body.defaultAgent).toBe('my-agent');
  });
});
