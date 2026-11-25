import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readViewerUpload } from '../viewer-upload.js';
function upload(count = 1, name = 'made-up.txt', bytes = 'made-up content') {
  const body = Buffer.from(
    Array.from(
      { length: count },
      () =>
        `--fixture\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${bytes}\r\n`
    ).join('') + '--fixture--\r\n'
  );
  const req = Object.assign(Readable.from([body]), {
    headers: {
      'content-type': 'multipart/form-data; boundary=fixture',
      'content-length': String(body.length),
    },
    aborted: false,
  }) as unknown as IncomingMessage;
  return { req, body };
}
describe('volatile bounded viewer upload', () => {
  it('accepts exactly ten in-memory files and preserves display names only', async () => {
    const { req } = upload(10);
    const files = await readViewerUpload(req, new AbortController().signal);
    expect(files).toHaveLength(10);
    for (const f of files) {
      expect(f.name).toBe('made-up.txt');
      expect(f.buffer.toString()).toBe('made-up content');
      f.buffer.fill(0);
    }
  });
  it.each(['../secret', 'C:\\secret', '.', '..'])('refuses path-shaped name %s', async (name) => {
    await expect(
      readViewerUpload(upload(1, name).req, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'viewer_limit' });
  });
  it('refuses an eleventh file or a declared body over the wire cap', async () => {
    await expect(
      readViewerUpload(upload(11).req, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'viewer_limit' });
    const { req } = upload();
    req.headers['content-length'] = String(26 * 1024 * 1024);
    await expect(readViewerUpload(req, new AbortController().signal)).rejects.toMatchObject({
      code: 'viewer_limit',
    });
  });
  it('refuses aborted input without producing payloads', async () => {
    const signal = new AbortController();
    signal.abort();
    await expect(readViewerUpload(upload().req, signal.signal)).rejects.toMatchObject({
      code: 'viewer_stale',
    });
  });
});
