import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('fs/promises');

describe('UploadHandler', () => {
  let uploadHandler: typeof import('../upload-handler.js').uploadHandler;
  let fsMock: typeof import('fs/promises');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    fsMock = await import('fs/promises');

    const mod = await import('../upload-handler.js');
    uploadHandler = mod.uploadHandler;
  });

  describe('getUploadDir', () => {
    it('builds correct upload directory path', () => {
      const dir = uploadHandler.getUploadDir('/home/user/project');
      expect(dir).toBe(path.join('/home/user/project', '.dork', '.temp', 'uploads'));
    });

    it('handles trailing slash in cwd', () => {
      const dir = uploadHandler.getUploadDir('/home/user/project/');
      expect(dir).toBe(path.join('/home/user/project/', '.dork', '.temp', 'uploads'));
    });
  });

  describe('ensureUploadDir', () => {
    it('creates upload directory recursively', async () => {
      vi.mocked(fsMock.mkdir).mockResolvedValue(undefined);

      const dir = await uploadHandler.ensureUploadDir('/home/user/project');
      expect(dir).toBe(path.join('/home/user/project', '.dork', '.temp', 'uploads'));
      expect(fsMock.mkdir).toHaveBeenCalledWith(dir, { recursive: true });
    });
  });

  describe('createMulterMiddleware', () => {
    const config = { maxFileSize: 10 * 1024 * 1024, maxFiles: 10, allowedTypes: ['*/*'] };

    it('returns a multer instance', () => {
      const middleware = uploadHandler.createMulterMiddleware('/tmp/test', config);
      expect(middleware).toBeDefined();
      expect(typeof middleware.array).toBe('function');
    });

    it('returns a multer instance with restricted types', () => {
      const restrictedConfig = { ...config, allowedTypes: ['image/png', 'image/jpeg'] };
      const middleware = uploadHandler.createMulterMiddleware('/tmp/test', restrictedConfig);
      expect(middleware).toBeDefined();
    });

    it('exposes single and fields methods', () => {
      const middleware = uploadHandler.createMulterMiddleware('/tmp/test', config);
      expect(typeof middleware.single).toBe('function');
      expect(typeof middleware.fields).toBe('function');
    });
  });
});
