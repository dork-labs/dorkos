/**
 * @vitest-environment node
 *
 * The OpenCode media path, end to end within the adapter: a `file` part or a
 * tool's `attachments` array becomes real bytes on disk and an
 * `image_attachment` event that references them.
 *
 * Two of the five links this covers were the bug. `mapPartSnapshot` sent every
 * `file` part to a `default:` arm whose comment called it "turn bookkeeping",
 * and `mapToolCall` read `state.output` and nothing else — so an MCP tool
 * returning a screenshot was dropped on a path that never depended on the
 * upstream generated-image bug at all (anomalyco/opencode#12859).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StreamEvent } from '@dorkos/shared/types';
import { LocalSessionAttachmentStore } from '../../../session/attachments/local-session-attachment-store.js';
import { createOpenCodeEventContext } from '../events/event-mapper.js';
import { mapPartSnapshot } from '../events/part-event-mapper.js';
import { captureOpenCodeMedia } from '../events/media-capture.js';
import {
  OC_SESSION_A,
  TINY_PNG_DATA_URL,
  filePart,
  toolPart,
  toolStateCompleted,
  toolStateCompletedWithAttachments,
} from './opencode-sse-fixtures.js';

const SESSION = '11111111-2222-4333-8444-555555555555';

describe('OpenCode media capture', () => {
  let dorkHome: string;
  let store: LocalSessionAttachmentStore;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-oc-media-'));
    store = new LocalSessionAttachmentStore(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Drain the capture generator into an array. */
  async function drain(ctx: ReturnType<typeof createOpenCodeEventContext>) {
    const events: StreamEvent[] = [];
    for await (const event of captureOpenCodeMedia(store, SESSION, ctx)) events.push(event);
    return events;
  }

  describe("a tool's attachments — the path OpenCode populates today", () => {
    it('stores the bytes and announces them by URL', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      mapPartSnapshot(
        toolPart(
          OC_SESSION_A,
          'call_img',
          'screenshot',
          toolStateCompletedWithAttachments({}, 'captured', [
            filePart(OC_SESSION_A, 'prt_f1', { filename: 'shot.png' }),
          ])
        ),
        ctx
      );

      expect(ctx.pendingMedia).toHaveLength(1);
      const events = await drain(ctx);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('image_attachment');
      const data = events[0]!.data as Record<string, unknown>;
      expect(data.mediaType).toBe('image/png');
      expect(data.alt).toBe('shot.png');
      expect(String(data.url)).toMatch(
        new RegExp(`^/api/sessions/${SESSION}/attachments/[0-9a-f]{32}\\.png$`)
      );
      // The invariant: a reference, not a payload.
      expect(String(data.url).startsWith('data:')).toBe(false);
    });

    it('writes bytes that are actually the image, not a placeholder', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      mapPartSnapshot(
        toolPart(
          OC_SESSION_A,
          'call_img',
          'screenshot',
          toolStateCompletedWithAttachments({}, 'captured', [filePart(OC_SESSION_A, 'prt_f1')])
        ),
        ctx
      );
      await drain(ctx);

      const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
      const [name] = await readdir(dir);
      const bytes = await readFile(path.join(dir, name!));
      // PNG magic — proof the base64 round-tripped rather than being stored raw.
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    });

    it('is idempotent across a re-published snapshot', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      const part = toolPart(
        OC_SESSION_A,
        'call_img',
        'screenshot',
        toolStateCompletedWithAttachments({}, 'captured', [filePart(OC_SESSION_A, 'prt_f1')])
      );
      mapPartSnapshot(part, ctx);
      const first = await drain(ctx);
      // A fresh context is the history-read analog: same tool call, same index.
      const reread = createOpenCodeEventContext(SESSION);
      mapPartSnapshot(part, reread);
      const second = await drain(reread);

      expect((second[0]!.data as { url: string }).url).toBe(
        (first[0]!.data as { url: string }).url
      );
      const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
      expect(await readdir(dir)).toHaveLength(1);
    });

    it('records nothing for a tool that returned only text', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      mapPartSnapshot(
        toolPart(OC_SESSION_A, 'call_1', 'bash', toolStateCompleted({}, 'file1\nfile2\n')),
        ctx
      );

      expect(ctx.pendingMedia).toEqual([]);
      expect(await drain(ctx)).toEqual([]);
    });

    it('skips a non-image attachment rather than filing it as a picture', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      mapPartSnapshot(
        toolPart(
          OC_SESSION_A,
          'call_1',
          'fetch',
          toolStateCompletedWithAttachments({}, 'ok', [
            filePart(OC_SESSION_A, 'prt_f1', {
              mime: 'text/plain',
              url: 'data:text/plain;base64,aGk=',
            }),
          ])
        ),
        ctx
      );

      expect(ctx.pendingMedia).toEqual([]);
    });
  });

  describe('a republished snapshot announces one picture, once', () => {
    // `message.part.updated` carries a CUMULATIVE snapshot and fires at part
    // start, at part end, and on every tool state transition. Before the guard
    // in `recordMedia`, the `file` arm was the ONLY arm of `mapPartSnapshot`
    // with no single-shot defence, so three republications of one image
    // produced three `image_attachment` events — one file on disk, one URL, and
    // three pictures on screen, because the client's fold appends a part per
    // event with no upsert.
    //
    // The idempotence case above this one uses a FRESH context per call, which
    // is the history-read analog. These use ONE context, which is the live turn.
    it('a `file` snapshot republished within one turn yields exactly one event', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      const part = filePart(OC_SESSION_A, 'prt_gen01', { filename: 'banana.png' });

      mapPartSnapshot(part, ctx);
      mapPartSnapshot(part, ctx);
      mapPartSnapshot(part, ctx);

      expect(ctx.pendingMedia).toHaveLength(1);
      const events = await drain(ctx);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('image_attachment');
      const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
      expect(await readdir(dir)).toHaveLength(1);
    });

    it('a tool attachment republished within one turn yields exactly one event', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      const part = toolPart(
        OC_SESSION_A,
        'call_img',
        'screenshot',
        toolStateCompletedWithAttachments({}, 'captured', [filePart(OC_SESSION_A, 'prt_f1')])
      );

      mapPartSnapshot(part, ctx);
      mapPartSnapshot(part, ctx);

      expect(await drain(ctx)).toHaveLength(1);
    });

    it('two DIFFERENT images in one turn still get one event each', async () => {
      // The guard must key on identity, not on "have we seen any image" — a
      // turn that draws twice has two pictures.
      const ctx = createOpenCodeEventContext(SESSION);
      mapPartSnapshot(filePart(OC_SESSION_A, 'prt_one'), ctx);
      mapPartSnapshot(filePart(OC_SESSION_A, 'prt_two'), ctx);

      const events = await drain(ctx);

      expect(events).toHaveLength(2);
      const urls = new Set(events.map((e) => (e.data as { url: string }).url));
      expect(urls.size).toBe(2);
    });
  });

  describe('a `file` part — the path upstream still drops', () => {
    it('is recorded rather than falling through the default arm', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      const events = mapPartSnapshot(
        filePart(OC_SESSION_A, 'prt_gen01', { filename: 'banana.png' }),
        ctx
      );

      // The mapper itself stays pure: it emits nothing and records the intent.
      expect(events).toEqual([]);
      expect(ctx.pendingMedia).toHaveLength(1);
      expect((await drain(ctx))[0]!.type).toBe('image_attachment');
    });

    it('still drops the structural parts the default arm is actually for', () => {
      const ctx = createOpenCodeEventContext(SESSION);
      const events = mapPartSnapshot(
        { id: 'prt_s', sessionID: OC_SESSION_A, messageID: 'msg_1', type: 'step-start' },
        ctx
      );

      expect(events).toEqual([]);
      expect(ctx.pendingMedia).toEqual([]);
    });
  });

  describe('honest degradation', () => {
    it('says so when the image is larger than a session will keep', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      ctx.pendingMedia.push({
        mime: 'image/png',
        // 16 MiB of base64 — past the cap before anything is decoded.
        url: `data:image/png;base64,${'A'.repeat(16 * 1024 * 1024)}`,
        identity: ['part', 'prt_big'],
      });

      const events = await drain(ctx);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('error');
      expect(String((events[0]!.data as { message: string }).message)).toMatch(/too large/i);
    });

    it('refuses to fetch an image from a web address a model chose', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      ctx.pendingMedia.push({
        mime: 'image/png',
        url: 'https://example.test/pixel.png',
        identity: ['part', 'prt_remote'],
      });

      const events = await drain(ctx);

      expect(events[0]!.type).toBe('error');
      expect(String((events[0]!.data as { message: string }).message)).toMatch(/web address/i);
    });

    it('says so when no store is wired, rather than dropping the image silently', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      mapPartSnapshot(filePart(OC_SESSION_A, 'prt_gen01'), ctx);

      const events: StreamEvent[] = [];
      for await (const event of captureOpenCodeMedia(null, SESSION, ctx)) events.push(event);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('error');
    });

    it('drains completely, so a failure does not strand later images', async () => {
      const ctx = createOpenCodeEventContext(SESSION);
      ctx.pendingMedia.push(
        { mime: 'image/png', url: 'https://example.test/a.png', identity: ['a'] },
        { mime: 'image/png', url: TINY_PNG_DATA_URL, identity: ['b'] }
      );

      const events = await drain(ctx);

      expect(events.map((e) => e.type)).toEqual(['error', 'image_attachment']);
      expect(ctx.pendingMedia).toEqual([]);
    });
  });
});
