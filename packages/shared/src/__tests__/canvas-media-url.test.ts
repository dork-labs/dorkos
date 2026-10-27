import { describe, it, expect } from 'vitest';
import {
  isRoomCanvasMediaUrl,
  ROOM_CANVAS_MEDIA_FILE,
  roomCanvasMediaUrl,
} from '../canvas-media-url.js';

const NAME = `${'c'.repeat(16)}-${'b'.repeat(64)}.png`;

describe('canvas-media-url', () => {
  it('spells the address the server writes, and recognises it', () => {
    const url = roomCanvasMediaUrl('01ROOM', NAME);
    expect(url).toBe(`/api/rooms/01ROOM/canvas/media/${NAME}`);
    expect(isRoomCanvasMediaUrl(url)).toBe(true);
    expect(isRoomCanvasMediaUrl(url, '01ROOM')).toBe(true);
    expect(isRoomCanvasMediaUrl(url, '01OTHER')).toBe(false);
  });

  it('recognises nothing but that exact shape', () => {
    for (const src of [
      'docs/logo.png',
      '/api/rooms/01ROOM/attachments/x',
      `/api/rooms/01ROOM/canvas/media/../${NAME}`,
      `/api/rooms/01ROOM/canvas/media/${'b'.repeat(64)}.png`,
      `https://evil.test/api/rooms/01ROOM/canvas/media/${NAME}`,
    ]) {
      expect(isRoomCanvasMediaUrl(src), src).toBe(false);
    }
    expect(ROOM_CANVAS_MEDIA_FILE.test(NAME)).toBe(true);
    expect(ROOM_CANVAS_MEDIA_FILE.test('../x.png')).toBe(false);
  });
});
