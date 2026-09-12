/**
 * The session canvas through the in-process transport — what the Obsidian
 * embed can do with it, and what it says instead (spec `canvas-agent-seat`
 * §1.4, §1.6).
 *
 * **Unit tests rather than a browser leg, and that is the honest coverage.**
 * The embed runs inside Obsidian; no Playwright run in this repo drives it, so
 * a claim about it has to be made where it can be checked. What IS checked here
 * is the whole contract: reads go to the in-process seam, writes refuse in one
 * sentence a person can read, a host with no seam answers the empty table rather
 * than a plausible-looking wrong one, and the snapshot carries the canvas
 * because `DirectTransport` never goes through `deliverSessionStream`.
 *
 * The refusal is the shipped decision, not a gap: ADR `260825-194924` already
 * settled that the embed opens this machine's database READ-ONLY, because two
 * programs on different DorkOS versions writing one file is not worth carrying
 * to keep a tab open.
 *
 * @module shared/lib/direct/tests/session-canvas-methods
 */
import { describe, it, expect, vi } from 'vitest';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import {
  createDirectSessionCanvasMethods,
  EMBEDDED_CANVAS_IS_READ_ONLY,
} from '../session-canvas-methods';
import { createDirectSessionStreamMethods } from '../session-stream-methods';
import type { DirectTransportServices } from '../services';

const SESSION = 'sess-1';

/** One of the server's rows, as the embed's read-only view hands it over. */
const row: CanvasDocument = {
  id: 'doc-a',
  scope: `session:${SESSION}`,
  roomId: null,
  content: { type: 'file', sourcePath: '/src/a.ts' },
  title: 'a.ts',
  contentType: 'file',
  authorId: 'owner',
  pinned: false,
  rev: 1,
  lastTouchedBy: 'owner',
  lastTouchedAt: '2026-09-12T10:00:00.000Z',
  openedAt: '2026-09-12T09:00:00.000Z',
  lastActiveAt: '2026-09-12T10:00:00.000Z',
};

/** A snapshot as a runtime hands it over: always with an EMPTY canvas. */
function runtimeSnapshot(): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
    },
    pendingInteractions: [],
    queuedMessages: [],
    canvas: [],
    cursor: 0,
  };
}

/** The embedding host's services, with or without a canvas reader wired. */
function services(canvas?: DirectTransportServices['canvas']): DirectTransportServices {
  return {
    runtime: {
      getSessionSnapshot: vi.fn().mockResolvedValue(runtimeSnapshot()),
    },
    vaultRoot: '/vault',
    ...(canvas ? { canvas } : {}),
  } as unknown as DirectTransportServices;
}

describe('the session canvas through DirectTransport', () => {
  describe('with a canvas reader wired', () => {
    const reader = { list: vi.fn().mockReturnValue([row]), get: vi.fn().mockReturnValue(row) };

    it('reads this machine’s table, not a copy of its own', async () => {
      const methods = createDirectSessionCanvasMethods(services(reader));
      await expect(methods.listSessionCanvas(SESSION)).resolves.toEqual([row]);
      await expect(methods.getSessionCanvasDocument(SESSION, 'doc-a')).resolves.toEqual(row);
      expect(reader.list).toHaveBeenCalledWith(SESSION);
    });

    it('decorates the snapshot, because the embed never goes through the stream route', async () => {
      // The HTTP path adds this in `deliverSessionStream`. The embed has no such
      // place, so a snapshot that was not decorated here would arrive with an
      // empty canvas that looks exactly like a session with nothing on it.
      const stream = createDirectSessionStreamMethods(services(reader));
      const snapshot = await stream.getSessionSnapshot(SESSION);
      expect(snapshot.canvas).toEqual([row]);
    });

    it('refuses every write in one sentence a person can read', async () => {
      const methods = createDirectSessionCanvasMethods(services(reader));
      const content = { type: 'markdown', content: '# hi' } as const;
      await expect(methods.openSessionCanvasDocument(SESSION, content)).rejects.toThrow(
        EMBEDDED_CANVAS_IS_READ_ONLY
      );
      await expect(
        methods.updateSessionCanvasDocument(SESSION, 'doc-a', { content })
      ).rejects.toThrow(EMBEDDED_CANVAS_IS_READ_ONLY);
      await expect(methods.closeSessionCanvasDocument(SESSION, 'doc-a')).rejects.toThrow(
        EMBEDDED_CANVAS_IS_READ_ONLY
      );
      await expect(methods.setSessionCanvasEditing(SESSION, 'doc-a', true)).rejects.toThrow(
        EMBEDDED_CANVAS_IS_READ_ONLY
      );
      // Nothing was written anywhere, including locally. A refusal that left a
      // document on one screen would be the private-per-browser canvas this
      // whole phase removed, coming back through the embed.
      expect(reader.list).not.toHaveBeenCalledWith(SESSION, expect.anything());
    });
  });

  describe('with no canvas reader wired', () => {
    it('answers the empty table rather than a plausible wrong one', async () => {
      const methods = createDirectSessionCanvasMethods(services());
      await expect(methods.listSessionCanvas(SESSION)).resolves.toEqual([]);
      await expect(methods.getSessionCanvasDocument(SESSION, 'doc-a')).resolves.toBeNull();
      const stream = createDirectSessionStreamMethods(services());
      expect((await stream.getSessionSnapshot(SESSION)).canvas).toEqual([]);
    });

    it('still refuses a write, rather than succeeding into nothing', async () => {
      // The failure worth naming: a write that reported success and changed
      // nothing is indistinguishable from one that worked, until the next device
      // disagrees.
      const methods = createDirectSessionCanvasMethods(services());
      await expect(
        methods.openSessionCanvasDocument(SESSION, { type: 'markdown', content: '# hi' })
      ).rejects.toThrow(EMBEDDED_CANVAS_IS_READ_ONLY);
    });
  });
});
