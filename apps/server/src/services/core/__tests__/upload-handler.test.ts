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

  describe('uploadOptions', () => {
    const config = { maxFileSize: 10 * 1024 * 1024, maxFiles: 10, allowedTypes: ['*/*'] };
    const file = {
      fieldname: 'files',
      originalname: 'a.png',
      encoding: '7bit',
      mimetype: 'image/png',
    };

    it('reads the files field under the configured size and count limits', () => {
      const options = uploadHandler.uploadOptions('/tmp/test', config);
      expect(options.field).toBe('files');
      expect(options.maxCount).toBe(10);
      expect(options.limits).toEqual({ fileSize: 10 * 1024 * 1024, files: 10 });
    });

    it('stores on disk in the upload dir under a prefixed, sanitized name', () => {
      const options = uploadHandler.uploadOptions('/tmp/test', config);
      expect(options.disk?.directory).toBe(path.join('/tmp/test', '.dork', '.temp', 'uploads'));
      expect(options.disk?.filename('../we ird$.txt')).toMatch(/^[0-9a-f]{8}-we_ird_\.txt$/);
    });

    it('accepts any type under */* and refuses one the allowlist leaves out', () => {
      expect(uploadHandler.uploadOptions('/tmp/test', config).filter?.(file)).toBeUndefined();
      const restricted = uploadHandler.uploadOptions('/tmp/test', {
        ...config,
        allowedTypes: ['image/jpeg'],
      });
      expect(restricted.filter?.(file)?.message).toBe('File type not allowed: image/png');
      expect(restricted.filter?.({ ...file, mimetype: 'image/jpeg' })).toBeUndefined();
    });
  });
});
