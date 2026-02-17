import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Dirent } from 'fs';

vi.mock('fs/promises');
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

describe('FileListService', () => {
  let fileLister: typeof import('../../services/file-lister.js').fileLister;
  let execFileMock: ReturnType<typeof vi.fn>;
  let fs: typeof import('fs/promises');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();

    const cp = await import('child_process');
    execFileMock = vi.mocked(cp.execFile);

    fs = await import('fs/promises');

    const mod = await import('../../services/file-lister.js');
    fileLister = mod.fileLister;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockGitSuccess(files: string[]) {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string }) => void
      ) => {
        if (cb) {
          cb(null, { stdout: files.join('\n') + '\n' });
        }
        return undefined;
      }
    );
  }

  function mockGitFailure() {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) {
          cb(new Error('not a git repo'));
        }
        return undefined;
      }
    );
  }

  function makeDirent(name: string, isDir: boolean): Dirent {
    return {
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
      parentPath: '',
      path: '',
    } as Dirent;
  }

  it('returns file list from git ls-files', async () => {
    mockGitSuccess(['src/index.ts', 'package.json', 'README.md']);

    const result = await fileLister.listFiles('/project');

    expect(result.files).toEqual(['src/index.ts', 'package.json', 'README.md']);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
  });

  it('falls back to readdir when git fails', async () => {
    mockGitFailure();

    vi.mocked(fs.readdir).mockResolvedValueOnce([
      makeDirent('index.ts', false),
      makeDirent('lib', true),
    ] as any);

    vi.mocked(fs.readdir).mockResolvedValueOnce([makeDirent('utils.ts', false)] as any);

    const result = await fileLister.listFiles('/project');

    expect(result.files).toEqual(['index.ts', 'lib/utils.ts']);
    expect(result.truncated).toBe(false);
  });

  it('caches results and serves from cache on second call', async () => {
    mockGitSuccess(['a.ts', 'b.ts']);

    const first = await fileLister.listFiles('/project');
    const second = await fileLister.listFiles('/project');

    expect(first.files).toEqual(second.files);
    // execFile called only once due to caching (promisify wraps it)
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates cache after TTL expires', async () => {
    mockGitSuccess(['a.ts']);

    await fileLister.listFiles('/project');

    // Advance past cache TTL (5 minutes)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    mockGitSuccess(['a.ts', 'b.ts']);
    const result = await fileLister.listFiles('/project');

    expect(result.files).toEqual(['a.ts', 'b.ts']);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('excludes node_modules and .git in readdir fallback', async () => {
    mockGitFailure();

    vi.mocked(fs.readdir).mockResolvedValueOnce([
      makeDirent('src', true),
      makeDirent('node_modules', true),
      makeDirent('.git', true),
      makeDirent('index.ts', false),
    ] as any);

    vi.mocked(fs.readdir).mockResolvedValueOnce([makeDirent('app.ts', false)] as any);

    const result = await fileLister.listFiles('/project2');

    expect(result.files).toEqual(['src/app.ts', 'index.ts']);
  });

  it('invalidateCache clears specific cwd', async () => {
    mockGitSuccess(['a.ts']);
    await fileLister.listFiles('/proj-a');

    fileLister.invalidateCache('/proj-a');

    mockGitSuccess(['a.ts', 'new.ts']);
    const result = await fileLister.listFiles('/proj-a');

    expect(result.files).toEqual(['a.ts', 'new.ts']);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
