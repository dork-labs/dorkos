import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuntimeProvisionResult } from '@dorkos/shared/transport';

// Mock the provisioning service — never run a real install through the route.
vi.mock('../../services/runtimes/opencode/provision.js', () => ({
  provisionOpenCode: vi.fn(),
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { provisionOpenCode } from '../../services/runtimes/opencode/provision.js';

const app = createApp();

describe('POST /api/runtimes/opencode/provision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams progress frames and a terminal result on success (loopback)', async () => {
    vi.mocked(provisionOpenCode).mockImplementation(async (onProgress) => {
      onProgress?.({ stage: 'starting', message: 'Installing opencode-ai@1.17.13…' });
      onProgress?.({ stage: 'installing', message: 'added 1 package' });
      const result: RuntimeProvisionResult = { ok: true, binaryPath: '/dork/opencode' };
      onProgress?.({ stage: 'done', message: 'OpenCode installed.' });
      return result;
    });

    const res = await request(app).post('/api/runtimes/opencode/provision');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Progress frames streamed, then the terminal result frame carried the outcome.
    expect(res.text).toContain('event: progress');
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":true');
    expect(res.text).toContain('/dork/opencode');
    expect(provisionOpenCode).toHaveBeenCalledOnce();
    expect(typeof vi.mocked(provisionOpenCode).mock.calls[0][0]).toBe('function');
  });

  it('streams the honest error result when provisioning fails', async () => {
    vi.mocked(provisionOpenCode).mockResolvedValue({
      ok: false,
      error: 'Could not install OpenCode. Check your connection and try again.',
    });

    const res = await request(app).post('/api/runtimes/opencode/provision');

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('"ok":false');
    expect(res.text).toContain('Could not install OpenCode');
  });

  it('rejects a non-loopback origin with 403 and never provisions', async () => {
    const res = await request(app)
      .post('/api/runtimes/opencode/provision')
      .set('Host', 'evil.example.com');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/locally/i);
    expect(provisionOpenCode).not.toHaveBeenCalled();
  });
});
