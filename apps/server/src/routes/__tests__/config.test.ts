import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock tunnel-manager and agent-manager to avoid side effects
vi.mock('../../services/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null },
  },
}));

vi.mock('../../services/agent-manager.js', () => ({
  resolveClaudeCliPath: () => '/usr/local/bin/claude',
  agentManager: {},
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
    const { initConfigManager } = await import('../../services/config-manager.js');
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

  it('returns 200 for empty object body (no-op)', async () => {
    const response = await request(app)
      .patch('/api/config')
      .send({})
      .expect(200);

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
    const { configManager } = await import('../../services/config-manager.js');
    expect(configManager.getDot('ui.theme')).toBe('dark');
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
