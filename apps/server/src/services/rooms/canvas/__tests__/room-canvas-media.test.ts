/**
 * A local picture or PDF an agent puts on a room's canvas is copied into the
 * room, so the rest of the room can see it — and a file that is not the
 * agent's is refused out loud rather than reported as shared.
 *
 * Over a real filesystem, because the one thing this could get wrong is which
 * files count as the agent's, and that is a filesystem question.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UiCommand } from '@dorkos/shared/schemas';
import { isRoomCanvasMediaUrl } from '@dorkos/shared/canvas-media-url';
import { initBoundary } from '../../../../lib/boundary.js';
import { findRoomCanvasMedia, shareCanvasMedia } from '../room-canvas-media.js';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_NAME = `${createHash('sha256').update(PNG).digest('hex')}.png`;
const ROOM = '01ROOMCANVASMEDIA000000000';

let root: string;
let anaCwd: string;
let kaiCwd: string;
let roomsDir: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-canvas-media-')));
  anaCwd = path.join(root, 'agents', 'ana');
  kaiCwd = path.join(root, 'agents', 'kai');
  roomsDir = path.join(root, 'rooms');
  await fs.mkdir(path.join(anaCwd, 'out'), { recursive: true });
  await fs.mkdir(kaiCwd, { recursive: true });
  await fs.mkdir(roomsDir, { recursive: true });
  await fs.writeFile(path.join(anaCwd, 'out', 'chart.png'), PNG);
  await fs.writeFile(path.join(kaiCwd, 'secret.png'), PNG);
  await initBoundary(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Share as Ana, from her own folder, with a 1 MB limit. */
function share(command: UiCommand, ownCopy: string | null = null): Promise<UiCommand> {
  return shareCanvasMedia({
    roomId: ROOM,
    command,
    cwd: anaCwd,
    ownCopy: async () => ownCopy,
    roomsDir,
    maxFileSize: () => 1024 * 1024,
  });
}

/** The `src` a command ended up with. */
function srcOf(command: UiCommand): string {
  return (command as { content: { src: string } }).content.src;
}

describe('shareCanvasMedia', () => {
  it('copies a picture from the agent’s own folder into the room and points at the copy', async () => {
    const shared = await share({
      action: 'open_canvas',
      content: { type: 'image', src: path.join(anaCwd, 'out', 'chart.png'), alt: 'Chart' },
      target: { roomId: ROOM },
    });
    expect(shared.action).toBe('open_canvas');
    expect(srcOf(shared)).toBe(`/api/rooms/${ROOM}/canvas/media/${PNG_NAME}`);
    expect(isRoomCanvasMediaUrl(srcOf(shared), ROOM)).toBe(true);
    // Everything else the agent sent is kept.
    expect((shared as { content: { alt: string } }).content.alt).toBe('Chart');
    expect((shared as { target: { roomId: string } }).target.roomId).toBe(ROOM);
    const copied = await fs.readFile(path.join(roomsDir, ROOM, 'canvas-media', PNG_NAME));
    expect(copied.equals(PNG)).toBe(true);
  });

  it('resolves a relative path against the agent’s own folder', async () => {
    const shared = await share({
      action: 'open_canvas',
      content: { type: 'image', src: 'out/chart.png' },
    });
    expect(srcOf(shared)).toBe(`/api/rooms/${ROOM}/canvas/media/${PNG_NAME}`);
  });

  it('gives the same picture the same address, so a second open is the same document', async () => {
    const command: UiCommand = {
      action: 'open_canvas',
      content: { type: 'image', src: 'out/chart.png' },
    };
    expect(srcOf(await share(command))).toBe(srcOf(await share(command)));
  });

  it('turns an open_file of a PDF into the open it implied', async () => {
    await fs.writeFile(path.join(anaCwd, 'out', 'brief.pdf'), '%PDF-1.4\n%%EOF\n');
    const shared = await share({
      action: 'open_file',
      sourcePath: 'out/brief.pdf',
      target: { roomId: ROOM },
    });
    expect(shared).toMatchObject({
      action: 'open_canvas',
      content: { type: 'pdf' },
      target: { roomId: ROOM },
    });
    expect(srcOf(shared)).toMatch(/\/canvas\/media\/[0-9a-f]{64}\.pdf$/);
  });

  it('accepts a file in the agent’s own copy of the room’s files', async () => {
    const copy = path.join(roomsDir, ROOM, 'worktrees', 'ana-abc');
    await fs.mkdir(copy, { recursive: true });
    await fs.writeFile(path.join(copy, 'mock.png'), PNG);
    const shared = await share(
      { action: 'open_canvas', content: { type: 'image', src: path.join(copy, 'mock.png') } },
      copy
    );
    expect(srcOf(shared)).toBe(`/api/rooms/${ROOM}/canvas/media/${PNG_NAME}`);
  });

  it('refuses another member’s file, with the reason, and copies nothing', async () => {
    await expect(
      share({
        action: 'open_canvas',
        content: { type: 'image', src: path.join(kaiCwd, 'secret.png') },
      })
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_PATH_REFUSED',
      message: expect.stringContaining("put it on the room's canvas"),
    });
    await expect(fs.stat(path.join(roomsDir, ROOM, 'canvas-media'))).rejects.toThrow();
  });

  it('refuses a file bigger than the upload limit', async () => {
    await fs.writeFile(path.join(anaCwd, 'out', 'big.png'), Buffer.alloc(2 * 1024 * 1024));
    await expect(
      share({ action: 'open_canvas', content: { type: 'image', src: 'out/big.png' } })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('refuses a kind of file the canvas cannot show', async () => {
    await fs.writeFile(path.join(anaCwd, 'out', 'notes.txt'), 'hi');
    await expect(
      share({ action: 'open_canvas', content: { type: 'image', src: 'out/notes.txt' } })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNREADABLE' });
  });

  it('leaves URLs, inline data, this room’s copies and non-media content alone', async () => {
    const unchanged: UiCommand[] = [
      { action: 'open_canvas', content: { type: 'image', src: 'https://example.test/a.png' } },
      { action: 'open_canvas', content: { type: 'image', src: 'data:image/png;base64,AAAA' } },
      {
        action: 'open_canvas',
        content: { type: 'image', src: `/api/rooms/${ROOM}/canvas/media/${PNG_NAME}` },
      },
      { action: 'open_canvas', content: { type: 'markdown', content: '# hi' } },
      { action: 'open_file', sourcePath: 'src/index.ts' },
      { action: 'close_canvas' },
    ];
    for (const command of unchanged) {
      expect(await share(command)).toBe(command);
    }
  });
});

describe('findRoomCanvasMedia', () => {
  it('finds a copied file, and nothing for a name no copy could have', async () => {
    await share({ action: 'open_canvas', content: { type: 'image', src: 'out/chart.png' } });
    const found = await findRoomCanvasMedia(roomsDir, ROOM, PNG_NAME);
    expect(found).toMatchObject({ contentType: 'image/png', size: PNG.byteLength });

    expect(await findRoomCanvasMedia(roomsDir, ROOM, '../../agents/kai/secret.png')).toBeNull();
    expect(await findRoomCanvasMedia(roomsDir, ROOM, 'chart.png')).toBeNull();
    expect(await findRoomCanvasMedia(roomsDir, '..', PNG_NAME)).toBeNull();
    expect(await findRoomCanvasMedia(roomsDir, 'OTHERROOM', PNG_NAME)).toBeNull();
  });
});
