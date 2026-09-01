/**
 * @vitest-environment node
 *
 * The session attachment store: what it stores, what it refuses, and the
 * path-safety guarantees that let its ids come off a URL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalSessionAttachmentStore } from '../local-session-attachment-store.js';
import { UnsupportedSessionMediaError } from '../session-attachment-store.js';
import { MAX_SESSION_ATTACHMENT_BYTES } from '../session-media-types.js';
import { deriveSessionAttachmentId } from '../session-attachment-id.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('LocalSessionAttachmentStore', () => {
  let dorkHome: string;
  let store: LocalSessionAttachmentStore;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-session-attachments-'));
    store = new LocalSessionAttachmentStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('stores bytes under the suffix its media type maps to, and answers a fetchable URL', async () => {
    const put = await store.put(SESSION, 'abc123', 'image/png', PNG);

    expect(put).toEqual({
      url: `/api/sessions/${SESSION}/attachments/abc123.png`,
      mediaType: 'image/png',
      size: PNG.byteLength,
    });
    const files = await readdir(path.join(dorkHome, 'sessions', SESSION, 'attachments'));
    expect(files).toEqual(['abc123.png']);
  });

  it('normalizes a media type with parameters and casing', async () => {
    const put = await store.put(SESSION, 'abc123', 'IMAGE/PNG; charset=binary', PNG);
    expect(put.mediaType).toBe('image/png');
    expect(put.url.endsWith('.png')).toBe(true);
  });

  it('reads the bytes back with the content type its suffix names', async () => {
    await store.put(SESSION, 'abc123', 'image/png', PNG);

    const stored = await store.get(SESSION, 'abc123', 'png');
    expect(stored).not.toBeNull();
    expect(stored!.contentType).toBe('image/png');
    expect(stored!.size).toBe(PNG.byteLength);
    expect(stored!.etag.startsWith('W/"')).toBe(true);
    stored!.stream.destroy();
  });

  it('is idempotent on a deterministic id — a second put replaces, never duplicates', async () => {
    const id = deriveSessionAttachmentId(['tool', 'call_1', '0']);
    const first = await store.put(SESSION, id, 'image/png', PNG);
    const second = await store.put(SESSION, id, 'image/png', PNG);

    expect(second.url).toBe(first.url);
    const files = await readdir(path.join(dorkHome, 'sessions', SESSION, 'attachments'));
    expect(files).toEqual([`${id}.png`]);
  });

  it('peek answers what a prior put answered, and null when nothing is stored', async () => {
    expect(await store.peek(SESSION, 'abc123', 'image/png')).toBeNull();
    const put = await store.put(SESSION, 'abc123', 'image/png', PNG);
    expect(await store.peek(SESSION, 'abc123', 'image/png')).toEqual(put);
  });

  it('refuses SVG — the one image format that executes', async () => {
    await expect(
      store.put(SESSION, 'abc123', 'image/svg+xml', Buffer.from('<svg/>'))
    ).rejects.toBeInstanceOf(UnsupportedSessionMediaError);
  });

  it('refuses a non-image media type', async () => {
    await expect(store.put(SESSION, 'abc123', 'application/pdf', PNG)).rejects.toBeInstanceOf(
      UnsupportedSessionMediaError
    );
  });

  it('refuses bytes past the cap WHOLE, rather than truncating them', async () => {
    const tooBig = Buffer.alloc(MAX_SESSION_ATTACHMENT_BYTES + 1);
    await expect(store.put(SESSION, 'abc123', 'image/png', tooBig)).rejects.toBeInstanceOf(
      UnsupportedSessionMediaError
    );
    // Nothing half-written: a truncated PNG is not a smaller PNG.
    await expect(
      readdir(path.join(dorkHome, 'sessions', SESSION, 'attachments'))
    ).rejects.toThrow();
  });

  it('refuses an attachment id that could be read as a path', async () => {
    await expect(store.put(SESSION, '../escape', 'image/png', PNG)).rejects.toThrow(
      /not a usable session attachment id/i
    );
    await expect(store.put('../..', 'abc123', 'image/png', PNG)).rejects.toThrow(
      /not a usable session attachment id/i
    );
  });

  it('reads answer null for an unusable id rather than throwing', async () => {
    expect(await store.get(SESSION, '../escape', 'png')).toBeNull();
    expect(await store.get('../..', 'abc123', 'png')).toBeNull();
  });

  it('will not serve a suffix it could never have written, even if a file is there', async () => {
    const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'evil.svg'), '<svg onload="alert(1)"/>');

    expect(await store.get(SESSION, 'evil', 'svg')).toBeNull();
  });
});

describe('deriveSessionAttachmentId', () => {
  it('is stable for the same components, so a history read finds the live turn’s file', () => {
    expect(deriveSessionAttachmentId(['tool', 'call_1', '0'])).toBe(
      deriveSessionAttachmentId(['tool', 'call_1', '0'])
    );
  });

  it('separates components unambiguously', () => {
    expect(deriveSessionAttachmentId(['a', 'b'])).not.toBe(deriveSessionAttachmentId(['ab']));
    expect(deriveSessionAttachmentId(['a|b'])).not.toBe(deriveSessionAttachmentId(['a', 'b']));
  });

  it('is always a filesystem- and URL-safe fixed-length token', () => {
    const id = deriveSessionAttachmentId(['../../etc/passwd', '\n', 'x'.repeat(500)]);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
