import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';

// Mock @inquirer/prompts
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}));

// Stable reference for the mock `all` function — survives clearAllMocks
const mockAll = vi.fn<() => Array<{ project_path: string }>>(() => []);

vi.mock('better-sqlite3', () => {
  // Must use function() form so `new Database()` works as a constructor
  function MockDatabase() {
    return {
      prepare: vi.fn(() => ({ all: mockAll })),
      close: vi.fn(),
    };
  }
  return { default: MockDatabase };
});

import { confirm } from '@inquirer/prompts';
import { runCleanup } from '../cleanup-command.js';

/** Create a temporary directory for testing. */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-cleanup-test-'));
}

describe('runCleanup', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let httpGetSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = createTempDir();
    vi.clearAllMocks();

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Default: server not running (error callback fires immediately)
    httpGetSpy = vi.spyOn(http, 'get').mockImplementation((_url, _opts, _cb) => {
      const req = {
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'error') handler();
          return req;
        }),
        destroy: vi.fn(),
      };
      return req as unknown as http.ClientRequest;
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    httpGetSpy.mockRestore();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits early when dorkHome does not exist', async () => {
    const nonexistent = path.join(tmpDir, 'nonexistent');

    await runCleanup({ dorkHome: nonexistent });

    expect(confirm).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Nothing to clean up'));
  });

  it('exits early when dorkHome is empty', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir);

    await runCleanup({ dorkHome: emptyDir });

    expect(confirm).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Nothing to clean up'));
  });

  it('shows inventory and removes global data when confirmed', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'logs'));

    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runCleanup({ dorkHome: tmpDir });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('config.json'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('logs'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Removed ${tmpDir}`));
    expect(fs.existsSync(tmpDir)).toBe(false);
  });

  it('aborts when user declines global confirmation', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

    vi.mocked(confirm).mockResolvedValueOnce(false);

    await runCleanup({ dorkHome: tmpDir });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Aborted'));
    expect(fs.existsSync(tmpDir)).toBe(true);
  });

  it('shows per-project dirs from DB and removes when confirmed', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dork.db'), '');
    // Project dir must be outside dorkHome (separate temp dir)
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-project-'));
    fs.mkdirSync(path.join(projectDir, '.dork'), { recursive: true });

    mockAll.mockReturnValue([{ project_path: projectDir }]);

    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // confirm global
      .mockResolvedValueOnce(true); // confirm per-project

    try {
      await runCleanup({ dorkHome: tmpDir });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 project(s)'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Removed ${path.join(projectDir, '.dork')}`)
      );
      expect(fs.existsSync(path.join(projectDir, '.dork'))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('skips per-project when user declines (global still removed)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dork.db'), '');
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-project-'));
    fs.mkdirSync(path.join(projectDir, '.dork'), { recursive: true });

    mockAll.mockReturnValue([{ project_path: projectDir }]);

    vi.mocked(confirm)
      .mockResolvedValueOnce(true) // confirm global
      .mockResolvedValueOnce(false); // decline per-project

    try {
      await runCleanup({ dorkHome: tmpDir });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Skipped per-project data'));
      expect(fs.existsSync(path.join(projectDir, '.dork'))).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('handles missing DB gracefully (no per-project prompt)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runCleanup({ dorkHome: tmpDir });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Will NOT touch'));
  });

  it('skips per-project paths that no longer exist on disk', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dork.db'), '');

    mockAll.mockReturnValue([{ project_path: '/tmp/nonexistent-project' }]);

    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runCleanup({ dorkHome: tmpDir });

    // No per-project prompt since all paths were filtered out
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('warns and exits when server is running', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ server: { port: 9999 } }));

    httpGetSpy.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: { statusCode: number; resume: () => void }) => void;
      callback({ statusCode: 200, resume: () => {} });
      const req = { on: vi.fn().mockReturnThis(), destroy: vi.fn() };
      return req as unknown as http.ClientRequest;
    });

    await runCleanup({ dorkHome: tmpDir });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('server is running'));
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(tmpDir)).toBe(true);
  });

  it('prints safe notice and uninstall instruction after cleanup', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runCleanup({ dorkHome: tmpDir });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('~/.claude/'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('npm uninstall -g dorkos'));
  });
});
