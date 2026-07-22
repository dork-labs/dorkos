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

      await expect(
        boundary.validateBoundary('/home/user/project', '/home/other')
      ).rejects.toMatchObject({
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
  // validateBoundaryOrDorkHome — the agent-registry seam
  // ---------------------------------------------------------------------------
  describe('validateBoundaryOrDorkHome', () => {
    // A boundary that does NOT contain dork-home — the Docker deployment shape
    // (DORKOS_BOUNDARY=/workspace, dork-home at /home/node/.dork).
    const BOUNDARY = '/workspace';
    const DORK_HOME = '/home/node/.dork';
    const originalDorkHome = process.env.DORK_HOME;

    beforeEach(() => {
      process.env.DORK_HOME = DORK_HOME;
    });

    afterEach(() => {
      if (originalDorkHome === undefined) delete process.env.DORK_HOME;
      else process.env.DORK_HOME = originalDorkHome;
    });

    it('accepts a dork-home path that the plain boundary rejects (the onboarding bug)', async () => {
      const agentPath = '/home/node/.dork/agents/dorkbot';

      // Plain boundary confines to /workspace → the system agent path is a 403.
      vi.mocked(fs.realpath).mockResolvedValueOnce(agentPath);
      await expect(boundary.validateBoundary(agentPath, BOUNDARY)).rejects.toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });

      // The seam accepts it: realpath(userPath), then realpath(dork-home).
      vi.mocked(fs.realpath).mockResolvedValueOnce(agentPath);
      vi.mocked(fs.realpath).mockResolvedValueOnce(DORK_HOME);
      const result = await boundary.validateBoundaryOrDorkHome(agentPath, BOUNDARY);
      expect(result).toBe(agentPath);
    });

    it('accepts the dork-home root itself', async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce(DORK_HOME); // userPath
      vi.mocked(fs.realpath).mockResolvedValueOnce(DORK_HOME); // dork-home resolve

      const result = await boundary.validateBoundaryOrDorkHome(DORK_HOME, BOUNDARY);

      expect(result).toBe(DORK_HOME);
    });

    it('accepts a boundary-internal path without consulting dork-home', async () => {
      const projectPath = '/workspace/project/app';
      vi.mocked(fs.realpath).mockResolvedValueOnce(projectPath);

      const result = await boundary.validateBoundaryOrDorkHome(projectPath, BOUNDARY);

      expect(result).toBe(projectPath);
      // Boundary containment short-circuits — dork-home is never realpath'd.
      expect(vi.mocked(fs.realpath)).toHaveBeenCalledTimes(1);
    });

    it('rejects a path outside both boundary and dork-home (rejected by both validators)', async () => {
      // Plain boundary rejects /etc/passwd.
      vi.mocked(fs.realpath).mockResolvedValueOnce('/etc/passwd');
      await expect(boundary.validateBoundary('/etc/passwd', BOUNDARY)).rejects.toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });

      // The seam rejects it too — it is in neither root.
      vi.mocked(fs.realpath).mockResolvedValueOnce('/etc/passwd'); // userPath
      vi.mocked(fs.realpath).mockResolvedValueOnce(DORK_HOME); // dork-home
      await expect(
        boundary.validateBoundaryOrDorkHome('/etc/passwd', BOUNDARY)
      ).rejects.toMatchObject({ code: 'OUTSIDE_BOUNDARY' });
    });

    it('rejects a dork-home sibling via the path.sep suffix (prefix-collision fix)', async () => {
      // /home/node/.dork-evil must not pass just because it prefixes /home/node/.dork.
      const evil = '/home/node/.dork-evil/agents';
      vi.mocked(fs.realpath).mockResolvedValueOnce(evil); // userPath
      vi.mocked(fs.realpath).mockResolvedValueOnce(DORK_HOME); // dork-home

      await expect(boundary.validateBoundaryOrDorkHome(evil, BOUNDARY)).rejects.toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });
    });

    it('realpath-resolves a symlinked dork-home before the containment check', async () => {
      process.env.DORK_HOME = '/sym/dork';
      const realAgent = '/real/dork/agents/dorkbot';
      vi.mocked(fs.realpath).mockResolvedValueOnce(realAgent); // userPath
      vi.mocked(fs.realpath).mockResolvedValueOnce('/real/dork'); // realpath('/sym/dork')

      const result = await boundary.validateBoundaryOrDorkHome(realAgent, BOUNDARY);

      expect(result).toBe(realAgent);
      // dork-home is resolved through its symlink, not trusted raw.
      expect(vi.mocked(fs.realpath)).toHaveBeenLastCalledWith('/sym/dork');
    });

    it('rejects null bytes before any filesystem access', async () => {
      await expect(
        boundary.validateBoundaryOrDorkHome('/home/node/.dork/x\0.json', BOUNDARY)
      ).rejects.toMatchObject({ name: 'BoundaryError', code: 'NULL_BYTE' });
      expect(vi.mocked(fs.realpath)).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // expandTilde
  // ---------------------------------------------------------------------------
  describe('expandTilde', () => {
    const home = os.homedir();

    it('expands bare ~ to home directory', () => {
      expect(boundary.expandTilde('~')).toBe(home);
    });

    it('expands ~/ prefix to home directory', () => {
      expect(boundary.expandTilde('~/.dork/agents')).toBe(`${home}/.dork/agents`);
    });

    it('expands ~/nested/path correctly', () => {
      expect(boundary.expandTilde('~/a/b/c')).toBe(`${home}/a/b/c`);
    });

    it('leaves absolute paths unchanged', () => {
      expect(boundary.expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
    });

    it('leaves relative paths without tilde unchanged', () => {
      expect(boundary.expandTilde('relative/path')).toBe('relative/path');
    });

    it('does not expand tilde in the middle of a path', () => {
      expect(boundary.expandTilde('/some/~/path')).toBe('/some/~/path');
    });

    it('does not expand ~user syntax (only bare ~ and ~/)', () => {
      expect(boundary.expandTilde('~otheruser/dir')).toBe('~otheruser/dir');
    });
  });

  // ---------------------------------------------------------------------------
  // validateBoundary — tilde expansion
  // ---------------------------------------------------------------------------
  describe('validateBoundary — tilde expansion', () => {
    const home = os.homedir();

    beforeEach(async () => {
      vi.mocked(fs.realpath).mockResolvedValueOnce(home);
      await boundary.initBoundary(home);
    });

    it('resolves tilde-prefixed path to home directory before validation', async () => {
      const expandedPath = `${home}/.dork/agents/dorkbot`;
      vi.mocked(fs.realpath).mockResolvedValueOnce(expandedPath);

      const result = await boundary.validateBoundary('~/.dork/agents/dorkbot');

      expect(result).toBe(expandedPath);
      // Should call realpath with the expanded path, not the raw tilde
      expect(vi.mocked(fs.realpath)).toHaveBeenLastCalledWith(expandedPath);
    });

    it('resolves tilde path that does not exist yet (ENOENT fallback)', async () => {
      const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      vi.mocked(fs.realpath).mockRejectedValueOnce(enoent);

      const result = await boundary.validateBoundary('~/.dork/agents/newbot');

      // path.resolve on the expanded path should keep it within boundary
      expect(result).toBe(`${home}/.dork/agents/newbot`);
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
