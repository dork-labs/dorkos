import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    refreshStatus: vi.fn(),
    status: {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
      passcodeEnabled: false,
    },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('../../lib/passcode-hash.js', () => ({
  hashPasscode: vi.fn(),
  verifyPasscode: vi.fn(),
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { configManager } from '../../services/core/config-manager.js';
import { hashPasscode, verifyPasscode } from '../../lib/passcode-hash.js';

const app = createApp();

const mockConfigGet = vi.mocked(configManager.get) as unknown as ReturnType<typeof vi.fn>;
const mockVerifyPasscode = vi.mocked(verifyPasscode);
const mockHashPasscode = vi.mocked(hashPasscode);

describe('Tunnel Passcode Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/tunnel/passcode/verify', () => {
    it('returns 200 and sets session for correct passcode', async () => {
      mockConfigGet.mockReturnValue({
        passcodeEnabled: true,
        passcodeHash: 'stored-hash',
        passcodeSalt: 'stored-salt',
      });
      mockVerifyPasscode.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/tunnel/passcode/verify')
        .send({ passcode: '123456' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockVerifyPasscode).toHaveBeenCalledWith('123456', 'stored-hash', 'stored-salt');
    });

    it('returns 401 for incorrect passcode', async () => {
      mockConfigGet.mockReturnValue({
        passcodeEnabled: true,
        passcodeHash: 'stored-hash',
        passcodeSalt: 'stored-salt',
      });
      mockVerifyPasscode.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/tunnel/passcode/verify')
        .send({ passcode: '000000' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: 'Incorrect passcode' });
    });

    it('returns 400 for non-numeric passcode', async () => {
      const res = await request(app)
        .post('/api/tunnel/passcode/verify')
        .send({ passcode: 'abcdef' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'Invalid passcode format' });
      expect(mockVerifyPasscode).not.toHaveBeenCalled();
    });

    it('returns 400 for wrong-length passcode', async () => {
      const res = await request(app).post('/api/tunnel/passcode/verify').send({ passcode: '123' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'Invalid passcode format' });
    });

    it('returns 400 when no passcode is configured', async () => {
      mockConfigGet.mockReturnValue({
        passcodeEnabled: false,
        passcodeHash: undefined,
        passcodeSalt: undefined,
      });

      const res = await request(app)
        .post('/api/tunnel/passcode/verify')
        .send({ passcode: '123456' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'No passcode configured' });
    });
  });

  describe('GET /api/tunnel/passcode/session', () => {
    it('returns passcodeRequired: true and authenticated: false when passcode enabled but not authenticated', async () => {
      mockConfigGet.mockReturnValue({
        passcodeEnabled: true,
        passcodeHash: 'some-hash',
        passcodeSalt: 'some-salt',
      });

      const res = await request(app).get('/api/tunnel/passcode/session');

      expect(res.status).toBe(200);
      expect(res.body.passcodeRequired).toBe(true);
      expect(res.body.authenticated).toBe(false);
    });

    it('returns passcodeRequired: false when passcode is disabled', async () => {
      mockConfigGet.mockReturnValue({
        passcodeEnabled: false,
        passcodeHash: undefined,
      });

      const res = await request(app).get('/api/tunnel/passcode/session');

      expect(res.status).toBe(200);
      expect(res.body.passcodeRequired).toBe(false);
    });

    it('returns passcodeRequired: false when no tunnel config exists', async () => {
      mockConfigGet.mockReturnValue(undefined);

      const res = await request(app).get('/api/tunnel/passcode/session');

      expect(res.status).toBe(200);
      expect(res.body.passcodeRequired).toBe(false);
      expect(res.body.authenticated).toBe(false);
    });
  });

  describe('POST /api/tunnel/passcode/set', () => {
    it('stores hashed passcode in config (never plaintext)', async () => {
      mockHashPasscode.mockResolvedValue({ hash: 'hashed-value', salt: 'random-salt' });
      mockConfigGet.mockReturnValue({ enabled: true });

      const res = await request(app).post('/api/tunnel/passcode/set').send({ passcode: '654321' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockHashPasscode).toHaveBeenCalledWith('654321');
      expect(configManager.set).toHaveBeenCalledWith('tunnel', {
        enabled: true,
        passcodeEnabled: true,
        passcodeHash: 'hashed-value',
        passcodeSalt: 'random-salt',
      });
      expect(tunnelManager.refreshStatus).toHaveBeenCalled();
    });

    it('returns 403 from non-localhost request', async () => {
      const res = await request(app)
        .post('/api/tunnel/passcode/set')
        .set('Host', 'remote.ngrok.io')
        .send({ passcode: '654321' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Passcode can only be changed locally');
      expect(configManager.set).not.toHaveBeenCalled();
    });

    it('disables passcode when enabled is false', async () => {
      mockConfigGet.mockReturnValue({
        enabled: true,
        passcodeEnabled: true,
        passcodeHash: 'old-hash',
        passcodeSalt: 'old-salt',
      });

      const res = await request(app).post('/api/tunnel/passcode/set').send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ passcodeEnabled: false })
      );
      expect(tunnelManager.refreshStatus).toHaveBeenCalled();
      expect(mockHashPasscode).not.toHaveBeenCalled();
    });

    it('rejects non-6-digit input', async () => {
      const res = await request(app).post('/api/tunnel/passcode/set').send({ passcode: '12345' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Passcode must be exactly 6 digits');
    });

    it('rejects alphabetic passcode', async () => {
      const res = await request(app).post('/api/tunnel/passcode/set').send({ passcode: 'abcdef' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Passcode must be exactly 6 digits');
    });

    it('rejects missing passcode when not disabling', async () => {
      const res = await request(app).post('/api/tunnel/passcode/set').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Passcode must be exactly 6 digits');
    });
  });
});
