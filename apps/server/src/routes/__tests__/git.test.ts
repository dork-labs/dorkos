import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../services/core/git-status.js', async (importOriginal) => ({
  // The real module keeps the agent facts slot it holds; only the read is faked.
  ...(await importOriginal<typeof import('../../services/core/git-status.js')>()),
  getGitStatus: vi.fn().mockResolvedValue({ branch: 'main', files: [] }),
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
import { composedListener } from '../../http/__tests__/composed-listener.js';
import { computerReadsRegistry } from '../../http/__tests__/computer-reads-registry.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';
import { getGitStatus } from '../../services/core/git-status.js';

// `git.status` is a capability the mount serves, so the test serves the server's real routing.
const admission = new MainRequestAdmission();
const testServer = listeningServer(
  composedListener(admission, { capabilities: computerReadsRegistry() })
);

describe('Git Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('boundary enforcement', () => {
    it('GET /api/git/status rejects dir outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(testServer).get('/api/git/status').query({ dir: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.type).toBe('application/problem+json');
      expect(res.body.code).toBe('outside_boundary');
    });

    it('GET /api/git/status rejects null byte paths with 400', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(testServer).get('/api/git/status').query({ dir: '/tmp\0evil' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });
  });

  it('answers an unexpected git failure as the hand route did, never naming the folder', async () => {
    vi.mocked(getGitStatus).mockRejectedValueOnce(new Error('git exploded in /Users/fixture/repo'));

    const res = await request(testServer)
      .get('/api/git/status')
      .query({ dir: '/Users/fixture/repo' });

    expect([res.status, res.body.code, res.body.detail]).toEqual([
      500,
      'internal_error',
      'DorkOS hit an error on its side.',
    ]);
    expect(res.text).not.toContain('/Users/fixture');
  });
});
