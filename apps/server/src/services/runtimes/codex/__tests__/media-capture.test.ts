/**
 * @vitest-environment node
 *
 * A picture an MCP tool handed Codex reaches the person who asked (DOR-1664).
 *
 * **There is deliberately no generated-image case here, and there cannot be
 * one.** `@openai/codex-sdk@0.147.0` declares `ThreadItem` as
 * `AgentMessageItem | ReasoningItem | CommandExecutionItem | FileChangeItem |
 * McpToolCallItem | WebSearchItem | TodoListItem | ErrorItem` — no image output
 * item of any kind. `type: "local_image"` exists only on `UserInput`, the input
 * direction. So an MCP tool result is Codex's ONE media path, and these are all
 * of its cases.
 *
 * Driven against a REAL {@link LocalSessionAttachmentStore} over a temp
 * directory rather than a double, because the claim under test is that the URL
 * announced is live on arrival.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImagePart, StreamEvent } from '@dorkos/shared/types';

vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

import { LocalSessionAttachmentStore } from '../../../session/attachments/local-session-attachment-store.js';
import { deriveSessionAttachmentId } from '../../../session/attachments/session-attachment-id.js';
import { captureCodexMedia, recordCodexMedia } from '../media-capture.js';
import { createCodexEventContext, mapCodexEvent } from '../event-mapper.js';
import {
  TINY_PNG_BASE64,
  codexItemCompleted,
  mcpImageToolCallItem,
  mcpToolCallItem,
} from './codex-scenarios.js';

const ITEM_ID = 'mcp-img-1';

/** Everything a readable stream has to say, as one Buffer. */
async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A store over a directory this test owns and removes. */
function makeStore(): { store: LocalSessionAttachmentStore; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'dorkos-codex-media-'));
  return { store: new LocalSessionAttachmentStore(home), home };
}

/** Collect an async generator. */
async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('finding the pictures in an MCP result', () => {
  it("reads MCP's own image block", () => {
    const ctx = createCodexEventContext('sess');
    recordCodexMedia(ctx, ITEM_ID, [
      { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' },
    ]);
    expect(ctx.pendingMedia).toEqual([
      { mediaType: 'image/png', base64: TINY_PNG_BASE64, identity: ['mcp', ITEM_ID, '0'] },
    ]);
  });

  it('finds none in the text results every other MCP tool returns', () => {
    const ctx = createCodexEventContext('sess');
    recordCodexMedia(ctx, ITEM_ID, [{ type: 'text', text: 'created' }]);
    recordCodexMedia(ctx, ITEM_ID, undefined);
    expect(ctx.pendingMedia).toEqual([]);
  });

  it('names the position, so two images in one result are two different pictures', () => {
    const ctx = createCodexEventContext('sess');
    recordCodexMedia(ctx, ITEM_ID, [
      { type: 'text', text: 'here they are' },
      { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' },
      { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' },
    ]);
    expect(ctx.pendingMedia.map((m) => m.identity)).toEqual([
      ['mcp', ITEM_ID, '1'],
      ['mcp', ITEM_ID, '2'],
    ]);
  });

  it('announces one picture once, however many times the item completes', () => {
    const ctx = createCodexEventContext('sess');
    const item = mcpImageToolCallItem(ITEM_ID);
    mapCodexEvent(codexItemCompleted(item), ctx);
    mapCodexEvent(codexItemCompleted(item), ctx);
    mapCodexEvent(codexItemCompleted(item), ctx);
    expect(ctx.pendingMedia).toHaveLength(1);
  });

  it('records nothing for a plain text-bearing MCP result the mapper already renders', () => {
    const ctx = createCodexEventContext('sess');
    const events = mapCodexEvent(
      codexItemCompleted(mcpToolCallItem(ITEM_ID, { status: 'completed', resultText: 'created' })),
      ctx
    );
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(ctx.pendingMedia).toEqual([]);
  });
});

describe('a turn whose MCP tool answers with a picture', () => {
  it('announces the image by URL, with the bytes already on disk', async () => {
    const { store, home } = makeStore();
    try {
      const ctx = createCodexEventContext('sess-live');
      mapCodexEvent(codexItemCompleted(mcpImageToolCallItem(ITEM_ID)), ctx);
      const events = await drain(captureCodexMedia(store, 'sess-live', ctx));

      const images = events.filter((e) => e.type === 'image_attachment');
      expect(images).toHaveLength(1);
      const data = images[0].data as ImagePart;
      expect(data.url.startsWith('data:')).toBe(false);
      expect(data.mediaType).toBe('image/png');
      expect(data.attachmentId).toBe(deriveSessionAttachmentId(['mcp', ITEM_ID, '0']));

      const stored = await store.get('sess-live', data.attachmentId, 'png');
      expect(stored).not.toBeNull();
      expect(await readAll(stored!.stream)).toEqual(Buffer.from(TINY_PNG_BASE64, 'base64'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes one file when the same picture is met twice', async () => {
    const { store, home } = makeStore();
    try {
      const first = createCodexEventContext('sess-twice');
      mapCodexEvent(codexItemCompleted(mcpImageToolCallItem(ITEM_ID)), first);
      const a = await drain(captureCodexMedia(store, 'sess-twice', first));

      // A SECOND turn on the same session meeting the same item id — the
      // deterministic attachment id is what makes this land on the first
      // turn's file rather than a copy of it.
      const second = createCodexEventContext('sess-twice');
      mapCodexEvent(codexItemCompleted(mcpImageToolCallItem(ITEM_ID)), second);
      const b = await drain(captureCodexMedia(store, 'sess-twice', second));

      expect((a[0].data as ImagePart).url).toBe((b[0].data as ImagePart).url);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps BOTH the words and the picture when a result carries each', async () => {
    // The ordinary mixed shape. `extractMcpResultText` still answers the text
    // block, and the image is announced beside it rather than instead of it.
    const { store, home } = makeStore();
    try {
      const ctx = createCodexEventContext('sess-mixed');
      const events = mapCodexEvent(
        codexItemCompleted(mcpImageToolCallItem(ITEM_ID, { text: 'captured example.test' })),
        ctx
      );
      expect(
        events.some(
          (e) =>
            e.type === 'tool_result' &&
            (e.data as { result: string }).result === 'captured example.test'
        ),
        'the text half of a mixed MCP result must still reach the transcript'
      ).toBe(true);

      const media = await drain(captureCodexMedia(store, 'sess-mixed', ctx));
      expect(media.map((e) => e.type)).toEqual(['image_attachment']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so out loud when there is nowhere to keep the picture', async () => {
    const ctx = createCodexEventContext('sess-nostore');
    mapCodexEvent(codexItemCompleted(mcpImageToolCallItem(ITEM_ID)), ctx);
    const events = await drain(captureCodexMedia(null, 'sess-nostore', ctx));
    expect(events.filter((e) => e.type === 'image_attachment')).toEqual([]);
    expect(events.map((e) => (e.data as { code?: string }).code)).toEqual([
      'SESSION_IMAGE_NOT_STORED',
    ]);
  });

  it('says so out loud for a format a session may not keep', async () => {
    const { store, home } = makeStore();
    try {
      const ctx = createCodexEventContext('sess-svg');
      recordCodexMedia(ctx, ITEM_ID, [
        {
          type: 'image',
          data: Buffer.from('<svg/>').toString('base64'),
          mimeType: 'image/svg+xml',
        },
      ]);
      const events = await drain(captureCodexMedia(store, 'sess-svg', ctx));
      expect(events.filter((e) => e.type === 'image_attachment')).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so out loud for a picture too large to keep', async () => {
    const { store, home } = makeStore();
    try {
      const ctx = createCodexEventContext('sess-huge');
      recordCodexMedia(ctx, ITEM_ID, [
        { type: 'image', data: 'A'.repeat(20 * 1024 * 1024), mimeType: 'image/png' },
      ]);
      const events = await drain(captureCodexMedia(store, 'sess-huge', ctx));
      expect(events.filter((e) => e.type === 'image_attachment')).toEqual([]);
      expect((events[0].data as { message: string }).message).toContain('too large');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
