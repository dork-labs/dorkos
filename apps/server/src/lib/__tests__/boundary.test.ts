import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';

// Mock fs/promises so tests don't touch the real filesystem
vi.mock('fs/promises');

describe('boundary module', () => {
  let fs: typeof import('fs/promises');
  let boundary: typeof import('../boundary.js');

  beforeEach(async () => {
    // Reset module state between tests so resolvedBoundary is null
    vi.resetModules();
    vi.clearAllMocks();
    fs = await import('fs/promises');
    boundary = await import('../boundary.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // initBoundary
  // ---------------------------------------------------------------------------
  describe('initBoundary', () => {
    it('defaults to os.homedir() when called with no argument', async () => {
      const home = os.homedir();
      vi.mocked(fs.realpath).mockResolvedValueOnce(home);

      const result = await boundary.initBoundary();

      expect(result).toBe(home);
      expect(vi.mocked(fs.realpath)).toHaveBeenCalledWith(home);
    });

    it('defaults to os.homedir() when called with null', async () => {
      const home = os.homedir();
      vi.mocked(fs.realpath).mockResolvedValueOnce(home);

      const result = await boundary.initBoundary(null);

      expect(result).toBe(home);
    });

    it('resolves the provided path via realpath (follows symlinks)', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/real/projects');

      const result = await boundary.initBoundary('/sym/projects');

      expect(result).toBe('/real/projects');
      expect(vi.mocked(fs.realpath)).toHaveBeenCalledWith('/sym/projects');
    });

    it('stores the resolved path so getBoundary() returns it', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/home/user');

      await boundary.initBoundary('/home/user');

      expect(boundary.getBoundary()).toBe('/home/user');
    });
  });

  // ---------------------------------------------------------------------------
  // getBoundary
  // ---------------------------------------------------------------------------
  describe('getBoundary', () => {
    it('throws if initBoundary() has not been called', () => {
      // Fresh module import — resolvedBoundary is null
      expect(() => boundary.getBoundary()).toThrow(
        'Boundary not initialized. Call initBoundary() at startup.'
      );
    });

    it('returns the resolved boundary after init', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/home/user');
      await boundary.initBoundary('/home/user');

      expect(boundary.getBoundary()).toBe('/home/user');
    });
  });

  // ---------------------------------------------------------------------------
  // validateBoundary — core validation
  // ---------------------------------------------------------------------------
  describe('validateBoundary', () => {
    const BOUNDARY = '/home/user';

    beforeEach(async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce(BOUNDARY);
      await boundary.initBoundary(BOUNDARY);
    });

    it('allows a path that exactly equals the boundary root', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce(BOUNDARY);

      const result = await boundary.validateBoundary(BOUNDARY);

      expect(result).toBe(BOUNDARY);
    });

    it('allows a path within the boundary', async () => {
      const validPath = '/home/user/projects/app';
      vi.mocked(fs.realpath).mockResolvedValueOnce(validPath);

      const result = await boundary.validateBoundary(validPath);

      expect(result).toBe(validPath);
    });

    it('rejects a path outside the boundary', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/etc/passwd');

      await expect(boundary.validateBoundary('/etc/passwd')).rejects.toMatchObject({
        name: 'BoundaryError',
        code: 'OUTSIDE_BOUNDARY',
        message: 'Access denied: path outside directory boundary',
      });
    });

    it('rejects /home/username when boundary is /home/user (prefix collision fix)', async () => {
      // This is the critical regression test for the path.sep fix.
      // Without `+ path.sep`, /home/user.startsWith('/home/user') === true,
      // which would incorrectly allow /home/username to pass.
      vi.mocked(fs.realpath).mockResolvedValueOnce('/home/username');

      await expect(boundary.validateBoundary('/home/username')).rejects.toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });
    });

    it('rejects a path with .. that resolves outside the boundary', async () => {
      // /home/user/../etc resolves to /etc
      vi.mocked(fs.realpath).mockResolvedValueOnce('/etc');

      await expect(boundary.validateBoundary('/home/user/../etc')).rejects.toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });
    });

    it('rejects a path containing null bytes', async () => {
      await expect(boundary.validateBoundary('/home/user/file\0.txt')).rejects.toMatchObject({
        name: 'BoundaryError',
        code: 'NULL_BYTE',
      });
    });

    it('throws BoundaryError with PERMISSION_DENIED when realpath returns EACCES', async () => {
      const eacces = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      vi.mocked(fs.realpath).mockRejectedValueOnce(eacces);

      await expect(boundary.validateBoundary('/home/user/protected')).rejects.toMatchObject({
        name: 'BoundaryError',
        code: 'PERMISSION_DENIED',
      });
    });

    it('re-throws unexpected errors from realpath', async () => {
      const unknownErr = Object.assign(new Error('EIO'), { code: 'EIO' });
      vi.mocked(fs.realpath).mockRejectedValueOnce(unknownErr);

      await expect(boundary.validateBoundary('/some/path')).rejects.toThrow('EIO');
    });

    it('handles ENOENT by falling back to path.resolve (non-existent path)', async () => {
      const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      vi.mocked(fs.realpath).mockRejectedValueOnce(enoent);

      // /home/user/newdir doesn't exist yet — path.resolve keeps it in boundary
      const result = await boundary.validateBoundary('/home/user/newdir');

      expect(result).toBe('/home/user/newdir');
    });

    it('rejects a non-existent path outside boundary (ENOENT + path.resolve)', async () => {
      const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      vi.mocked(fs.realpath).mockRejectedValueOnce(enoent);

      await expect(boundary.validateBoundary('/tmp/newdir')).rejects.toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });
    });

    it('accepts an explicit boundary override parameter', async () => {
      const altBoundary = '/home/other';
      const validPath = '/home/other/project';
      vi.mocked(fs.realpath).mockResolvedValueOnce(validPath);

      const result = await boundary.validateBoundary(validPath, altBoundary);

      expect(result).toBe(validPath);
    });

    it('rejects when path violates the explicit boundary override', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/home/user/project');

      await expect(boundary.validateBoundary('/home/user/project', '/home/other')).rejects.toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });
    });

    it('handles path with trailing slash by resolving to canonical form', async () => {
      // realpath naturally strips trailing slashes
      vi.mocked(fs.realpath).mockResolvedValueOnce('/home/user');

      const result = await boundary.validateBoundary('/home/user/');

      expect(result).toBe('/home/user');
    });
  });

  // ---------------------------------------------------------------------------
  // isWithinBoundary
  // ---------------------------------------------------------------------------
  describe('isWithinBoundary', () => {
    const BOUNDARY = '/home/user';

    beforeEach(async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce(BOUNDARY);
      await boundary.initBoundary(BOUNDARY);
    });

    it('returns true for a valid path inside boundary', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/home/user/docs');

      const result = await boundary.isWithinBoundary('/home/user/docs');

      expect(result).toBe(true);
    });

    it('returns true for the boundary root itself', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce(BOUNDARY);

      const result = await boundary.isWithinBoundary(BOUNDARY);

      expect(result).toBe(true);
    });

    it('returns false for a path outside the boundary (does not throw)', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/etc');

      const result = await boundary.isWithinBoundary('/etc');

      expect(result).toBe(false);
    });

    it('returns false for a path with null bytes (does not throw)', async () => {
      const result = await boundary.isWithinBoundary('/home/user/\0bad');

      expect(result).toBe(false);
    });

    it('returns false for paths where EACCES occurs (does not throw)', async () => {
      const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      vi.mocked(fs.realpath).mockRejectedValueOnce(eacces);

      const result = await boundary.isWithinBoundary('/home/user/secret');

      expect(result).toBe(false);
    });

    it('accepts an explicit boundary override parameter', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce('/home/other/project');

      const result = await boundary.isWithinBoundary('/home/other/project', '/home/other');

      expect(result).toBe(true);
    });
  });
});
