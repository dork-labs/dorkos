import { describe, expect, it } from 'vitest';
import { AppRequestFailure } from '../frame/app-request';
import { APP_MEDIA_MAX_BYTES, readAppMedia } from '../frame/app-media';

const reply = (body: BodyInit | null, headers: Record<string, string>, status = 200) =>
  new Response(body, { status, headers });

/** A body that streams `size` bytes and says nothing about its length. */
function unlabelled(size: number, type: string): Response {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const next = chunk.subarray(0, Math.min(chunk.byteLength, size - sent));
      sent += next.byteLength;
      controller.enqueue(next);
    },
  });
  return new Response(stream, { headers: { 'Content-Type': type } });
}

describe('api.media: a picture or video from the app’s own routes (DOR-3293)', () => {
  it.each([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/avif',
    'video/mp4',
    'video/webm',
  ])('hands over %s as a Blob of that type', async (type) => {
    const blob = await readAppMedia(reply(new Uint8Array([1, 2, 3]), { 'Content-Type': type }));
    expect(blob.type).toBe(type);
    expect(blob.size).toBe(3);
  });

  it('reads the type without its parameters, in any case', async () => {
    const blob = await readAppMedia(reply('x', { 'Content-Type': 'Video/MP4; codecs="avc1"' }));
    expect(blob.type).toBe('video/mp4');
  });

  it.each([
    ['SVG, which can carry script', 'image/svg+xml'],
    ['HTML', 'text/html'],
    ['JavaScript', 'text/javascript'],
    ['JSON', 'application/json'],
    ['a PDF', 'application/pdf'],
    ['raw bytes', 'application/octet-stream'],
    ['sound', 'audio/mpeg'],
    ['a type it does not name', ''],
  ])('refuses %s', async (_name, type) => {
    const headers: Record<string, string> = type ? { 'Content-Type': type } : {};
    await expect(readAppMedia(reply('<svg/>', headers))).rejects.toThrow('not a picture or video');
  });

  it('refuses a file over 32 MB by its stated size, before reading it', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.close();
      },
    });
    const response = reply(body, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(APP_MEDIA_MAX_BYTES + 1),
    });
    await expect(readAppMedia(response)).rejects.toThrow('too big');
    expect(pulled).toBe(false);
  });

  it('refuses a file over 32 MB that does not say its size, while reading', async () => {
    await expect(readAppMedia(unlabelled(APP_MEDIA_MAX_BYTES + 1, 'video/webm'))).rejects.toThrow(
      'too big'
    );
  });

  it('takes a file of exactly 32 MB', async () => {
    const blob = await readAppMedia(unlabelled(APP_MEDIA_MAX_BYTES, 'video/mp4'));
    expect(blob.size).toBe(APP_MEDIA_MAX_BYTES);
  });

  it('rejects a failed reply with its status and body, as api.request does', async () => {
    const failure = await readAppMedia(
      reply(JSON.stringify({ error: 'gone' }), { 'Content-Type': 'image/png' }, 404)
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AppRequestFailure);
    expect(failure).toMatchObject({ status: 404, body: { error: 'gone' } });
  });
});
