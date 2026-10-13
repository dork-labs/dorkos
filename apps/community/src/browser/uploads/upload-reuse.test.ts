import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_REUSE_MS, createUploadReuse } from './upload-reuse.js';

describe('createUploadReuse (DOR-2835)', () => {
  // Purpose: fails if sending a held message again uploads its files a second time, or reuses
  // an upload too old for the space to take, or replaces that one under the same key (which
  // the space would answer with the same old upload).
  it('reuses a file’s upload, then uploads it again under a new key once it is too old', async () => {
    let clock = 0;
    let uploads = 0;
    const upload = vi.fn(
      async (_channel: string, _file: File, _key: string) => `upload-${(uploads += 1)}`
    );
    const reuse = createUploadReuse(upload, () => clock);
    const file = new File(['a'], 'a.txt');

    expect(await reuse.attach('room', file)).toBe('upload-1');
    expect(await reuse.attach('room', file)).toBe('upload-1');
    expect(upload).toHaveBeenCalledTimes(1);

    clock = UPLOAD_REUSE_MS;
    expect(await reuse.attach('room', file)).toBe('upload-2');
    expect(upload.mock.calls[1]![2]).not.toBe(upload.mock.calls[0]![2]);
  });

  it('retries a lost upload under the same key', async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('upload');
    const reuse = createUploadReuse(upload);
    const file = new File(['a'], 'a.txt');
    await expect(reuse.attach('room', file)).rejects.toThrow('offline');
    expect(await reuse.attach('room', file)).toBe('upload');
    expect(upload.mock.calls[1]![2]).toBe(upload.mock.calls[0]![2]);
  });

  it('uploads again for another channel and after the message was posted', async () => {
    let uploads = 0;
    const upload = vi.fn(async () => `upload-${(uploads += 1)}`);
    const reuse = createUploadReuse(upload);
    const file = new File(['a'], 'a.txt');
    expect(await reuse.attach('room', file)).toBe('upload-1');
    expect(await reuse.attach('other', file)).toBe('upload-2');
    reuse.forget([file]);
    expect(await reuse.attach('other', file)).toBe('upload-3');
  });

  // Purpose: fails if a retried upload is dated from its answer rather than its first try (the
  // space keeps the first upload's time), or if a post retried after a lost answer swaps in new
  // uploads for old ones, which the space refuses for good under the same post key.
  it('dates an upload from its first try, and keeps old uploads for a lost-answer retry', async () => {
    let clock = 0;
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('upload-1')
      .mockResolvedValueOnce('upload-2');
    const reuse = createUploadReuse(upload, () => clock);
    const file = new File(['a'], 'a.txt');
    await expect(reuse.attach('room', file)).rejects.toThrow('offline');
    clock = 20 * 60_000;
    expect(await reuse.attach('room', file)).toBe('upload-1');
    clock = UPLOAD_REUSE_MS;
    expect(await reuse.attach('room', file, undefined, true)).toBe('upload-1');
    expect(await reuse.attach('room', file)).toBe('upload-2');
  });
});
