/**
 * @vitest-environment node
 *
 * A picture a Claude Code tool handed back reaches the person who asked — live
 * and on a later read of the same transcript (DOR-1664).
 *
 * Driven against a REAL {@link LocalSessionAttachmentStore} over a temp
 * directory rather than a double, because the claim under test is that the URL
 * announced is live on arrival. A double could report a URL for bytes nobody
 * wrote; a real store cannot.
 *
 * The fixtures are copied from a real turn (see `sdkImageToolResult`), not
 * invented: `claude -p "Read shot.png" --allowedTools Read` against an 8x8 PNG
 * emits exactly this on the stream and writes exactly this to its JSONL.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { readdir, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImagePart, StreamEvent } from '@dorkos/shared/types';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

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
import { createToolState, type AgentSession } from '../agent-types.js';
import {
  extractToolResultImages,
  recordToolResultImages,
  createToolResultImageState,
} from '../tool-result-images.js';
import { attachTranscriptImages, mapSdkMessageWithMedia } from '../media-capture.js';
import { parseTranscript, type TranscriptImageRef } from '../sessions/transcript-parser.js';
import { TINY_PNG_BASE64, imageTranscriptLines, sdkImageToolResult } from './sdk-scenarios.js';

const TOOL_ID = 'toolu_017pyTSTTbL2ih7UE7Nd3AX9';

/** Everything a readable stream has to say, as one Buffer. */
async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Where this store files one session's images. */
function attachmentDir(home: string, sessionId: string): string {
  return join(home, 'sessions', sessionId, 'attachments');
}

/** A store over a directory this test owns and removes. */
function makeStore(): { store: LocalSessionAttachmentStore; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'dorkos-cc-media-'));
  return { store: new LocalSessionAttachmentStore(home), home };
}

/** One `image` block, in the shape a real `Read` of a PNG produces. */
function imageBlock(mediaType = 'image/png', data = TINY_PNG_BASE64) {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/** An `SDKUserMessage` carrying the given tool results. */
function toolResultMessage(results: Array<{ toolUseId: string; content: unknown }>): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolUseId,
        content: r.content,
      })),
    },
    parent_tool_use_id: null,
    session_id: 'sdk-session',
    uuid: '00000000-0000-4000-8000-000000000001',
  } as unknown as SDKMessage;
}

/**
 * The `system/init` message that names a new session's CANONICAL id.
 *
 * The SDK emits it first on every query, which is why the canonical id is always
 * known by the time a tool result carrying an image arrives.
 */
function initMessage(sdkSessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sdkSessionId,
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'default',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    output_style: 'normal',
    skills: [],
    uuid: '00000000-0000-4000-8000-000000000003',
  } as unknown as SDKMessage;
}

/** The exact `SDKUserMessage` a `Read` of a PNG produces. */
function imageResultMessage(mediaType = 'image/png', data = TINY_PNG_BASE64): SDKMessage {
  return toolResultMessage([{ toolUseId: TOOL_ID, content: [imageBlock(mediaType, data)] }]);
}

/**
 * A session object with only the fields the message mapper reads.
 *
 * `sdkSessionId` is a PARAMETER because it is the key images are stored under,
 * and a fixture that hard-codes it cannot tell a resumed session (where the
 * request id and the canonical id are the same string) from a brand-new one
 * (where they are not) — the distinction the rebind case below exists for.
 */
function fakeSession(sdkSessionId: string | undefined): AgentSession {
  return {
    sdkSessionId,
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
  } as unknown as AgentSession;
}

/**
 * Drain the live mapper over one SDK message.
 *
 * @param initialSdkSessionId - What the session answers to BEFORE this turn
 *   starts. Defaults to `sessionId`, which is the resumed-session case
 *   (`sessions/session-store.ts`: "for resumed sessions, the sessionId IS the
 *   sdkSessionId"). Pass `undefined` for a brand-new session, whose canonical id
 *   does not exist until the turn's own `system/init` names it.
 */
async function driveLive(
  store: LocalSessionAttachmentStore | null,
  sessionId: string,
  messages: SDKMessage[],
  initialSdkSessionId: string | undefined = sessionId
): Promise<StreamEvent[]> {
  const toolState = createToolState();
  toolState.toolNameById.set(TOOL_ID, 'Read');
  toolState.toolNameById.set('toolu_A', 'Read');
  toolState.toolNameById.set('toolu_B', 'Read');
  const session = fakeSession(initialSdkSessionId);
  const events: StreamEvent[] = [];
  for (const message of messages) {
    for await (const event of mapSdkMessageWithMedia(
      store,
      message,
      session,
      sessionId,
      toolState
    )) {
      events.push(event);
    }
  }
  return events;
}

describe('finding the pictures in a tool result', () => {
  it('reads the image block a `Read` of a PNG really produces', () => {
    const images = extractToolResultImages(TOOL_ID, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
    ]);
    expect(images).toEqual([
      {
        kind: 'bytes',
        mediaType: 'image/png',
        base64: TINY_PNG_BASE64,
        identity: ['tool', TOOL_ID, '0'],
      },
    ]);
  });

  it('finds none in the text results every other tool returns', () => {
    expect(extractToolResultImages(TOOL_ID, 'plain string result')).toEqual([]);
    expect(extractToolResultImages(TOOL_ID, [{ type: 'text', text: 'ok' }])).toEqual([]);
    expect(extractToolResultImages(TOOL_ID, undefined)).toEqual([]);
  });

  it('names the position, so two images in one result are two different pictures', () => {
    const images = extractToolResultImages(TOOL_ID, [
      { type: 'text', text: 'here they are' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
    ]);
    expect(images.map((i) => i.identity)).toEqual([
      ['tool', TOOL_ID, '1'],
      ['tool', TOOL_ID, '2'],
    ]);
  });

  it('reports an image at a web address rather than fetching it', () => {
    const [image] = extractToolResultImages(TOOL_ID, [
      { type: 'image', source: { type: 'url', url: 'https://example.test/x.png' } },
    ]);
    expect(image.kind).toBe('unreadable');
    expect(image.kind === 'unreadable' && image.reason).toContain('not fetched from here');
  });

  it('announces one picture once, however many times the result is re-delivered', () => {
    const state = createToolResultImageState();
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
    ];
    recordToolResultImages(state, TOOL_ID, content);
    recordToolResultImages(state, TOOL_ID, content);
    recordToolResultImages(state, TOOL_ID, content);
    expect(state.pendingMedia).toHaveLength(1);
  });
});

describe('a live turn that reads a PNG', () => {
  it('announces the image by URL, with the bytes already on disk', async () => {
    const { store, home } = makeStore();
    try {
      const events = await driveLive(store, 'sess-live', [imageResultMessage()]);
      const images = events.filter((e) => e.type === 'image_attachment');
      expect(images).toHaveLength(1);

      const data = images[0].data as ImagePart;
      expect(data.url.startsWith('data:')).toBe(false);
      expect(data.mediaType).toBe('image/png');
      expect(data.size).toBe(Buffer.from(TINY_PNG_BASE64, 'base64').length);
      expect(data.attachmentId).toBe(deriveSessionAttachmentId(['tool', TOOL_ID, '0']));

      // The contract the whole design turns on: the URL is live on arrival.
      // Read the bytes back rather than trusting the answer — a store that
      // reported a URL for a file nobody wrote would pass a weaker assertion.
      const stored = await store.get('sess-live', data.attachmentId, 'png');
      expect(stored).not.toBeNull();
      expect(await readAll(stored!.stream)).toEqual(Buffer.from(TINY_PNG_BASE64, 'base64'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('announces the image before the turn ends, not after it', async () => {
    // The whole turn, message by message, in the order the SDK emits them.
    // Nothing may follow a `done` — the projector settles on it and the durable
    // stream is closed — so a picture drained at the END of a turn instead of
    // at the message that produced it would be lost in production while still
    // showing up in a test that only counted events.
    const { store, home } = makeStore();
    try {
      const messages: SDKMessage[] = [];
      for await (const message of sdkImageToolResult(TOOL_ID, '/projects/conformance/shot.png')) {
        messages.push(message);
      }
      const events = await driveLive(store, 'sess-order', messages);
      // The whole sequence, not a membership check: the picture lands directly
      // after the tool call that produced it and well before the turn's `done`.
      expect(events.map((e) => e.type)).toEqual([
        'session_status',
        'tool_call_start',
        'tool_call_delta',
        'tool_call_end',
        'image_attachment',
        'session_status',
        'done',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('announces it once even when the result is delivered twice', async () => {
    const { store, home } = makeStore();
    try {
      const events = await driveLive(store, 'sess-twice', [
        imageResultMessage(),
        imageResultMessage(),
      ]);
      expect(events.filter((e) => e.type === 'image_attachment')).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still shows the picture when the SDK summarized the tool result', async () => {
    // A `tool_use_summary` replaces a result's TEXT with a sentence. It does not
    // replace a picture, and there is nowhere else the bytes appear — so the
    // image must survive the skip that summary installs.
    const { store, home } = makeStore();
    try {
      const summary = {
        type: 'tool_use_summary',
        summary: 'Read an image',
        preceding_tool_use_ids: [TOOL_ID],
        session_id: 'sdk-session',
        uuid: '00000000-0000-4000-8000-000000000002',
      } as unknown as SDKMessage;
      const events = await driveLive(store, 'sess-summary', [summary, imageResultMessage()]);
      expect(events.filter((e) => e.type === 'image_attachment')).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps BOTH the words and the picture when a result carries each', async () => {
    // The ordinary mixed shape, and the one that proves the text path and the
    // image path do not exclude each other: `extractToolResultText` still
    // answers the text, and the image is announced beside it.
    const { store, home } = makeStore();
    try {
      const events = await driveLive(store, 'sess-mixed', [
        toolResultMessage([
          { toolUseId: TOOL_ID, content: [{ type: 'text', text: 'read 1 image' }, imageBlock()] },
        ]),
      ]);
      expect(events.map((e) => e.type)).toEqual(['tool_result', 'image_attachment']);
      expect((events[0].data as { result: string }).result).toBe('read 1 image');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps two parallel tool results in step with their own pictures', async () => {
    // What the IN-LOOP drain is for. The SDK batches parallel tool calls into
    // ONE user message, so this message yields two `tool_result` events and
    // carries two images. Draining only after the message finishes would
    // announce both pictures at the end — tool_result(A), tool_result(B),
    // image(A), image(B) — and attach each to the wrong step on screen.
    // Draining after every event keeps each picture with the call it came from.
    const { store, home } = makeStore();
    try {
      const events = await driveLive(store, 'sess-parallel', [
        toolResultMessage([
          { toolUseId: 'toolu_A', content: [{ type: 'text', text: 'A' }, imageBlock()] },
          { toolUseId: 'toolu_B', content: [{ type: 'text', text: 'B' }, imageBlock()] },
        ]),
      ]);
      expect(events.map((e) => e.type)).toEqual([
        'tool_result',
        'image_attachment',
        'tool_result',
        'image_attachment',
      ]);
      // And they are two DIFFERENT pictures, because identity is per tool call.
      const ids = events
        .filter((e) => e.type === 'image_attachment')
        .map((e) => (e.data as ImagePart).attachmentId);
      expect(new Set(ids).size).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so out loud when there is nowhere to keep the picture', async () => {
    const events = await driveLive(null, 'sess-nostore', [imageResultMessage()]);
    expect(events.filter((e) => e.type === 'image_attachment')).toEqual([]);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0].data as { code?: string }).code).toBe('SESSION_IMAGE_NOT_STORED');
  });

  it('says so out loud for a format a session may not keep', async () => {
    const { store, home } = makeStore();
    try {
      const events = await driveLive(store, 'sess-svg', [
        imageResultMessage('image/svg+xml', Buffer.from('<svg/>').toString('base64')),
      ]);
      expect(events.filter((e) => e.type === 'image_attachment')).toEqual([]);
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so out loud for a picture too large to keep', async () => {
    const { store, home } = makeStore();
    try {
      const events = await driveLive(store, 'sess-huge', [
        imageResultMessage('image/png', 'A'.repeat(20 * 1024 * 1024)),
      ]);
      expect(events.filter((e) => e.type === 'image_attachment')).toEqual([]);
      const [error] = events.filter((e) => e.type === 'error');
      expect((error.data as { message: string }).message).toContain('too large');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('reading the same turn back out of the transcript', () => {
  /** Parse the recorded shape and resolve its images through a store. */
  async function readHistory(store: LocalSessionAttachmentStore | null, sessionId: string) {
    const images: TranscriptImageRef[] = [];
    const messages = parseTranscript(imageTranscriptLines(TOOL_ID), images);
    await attachTranscriptImages(store, sessionId, messages, images);
    return messages;
  }

  it('puts the picture directly after the tool call that produced it', async () => {
    const { store, home } = makeStore();
    try {
      const messages = await readHistory(store, 'sess-history');
      const assistant = messages.find((m) => m.role === 'assistant');
      // 'text' comes from the model's reply record, which is what makes the
      // two assistant records consecutive and forces the merge (see
      // `imageTranscriptLines`). The image must still sit directly behind its
      // tool call after that merge rebuilt the array.
      expect(assistant?.parts?.map((p) => p.type)).toEqual(['tool_call', 'image', 'text']);
      const image = assistant!.parts![1] as ImagePart;
      expect(image.mediaType).toBe('image/png');
      expect(image.size).toBe(Buffer.from(TINY_PNG_BASE64, 'base64').length);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lands the same file at the same URL a live turn wrote, not a second copy', async () => {
    const { store, home } = makeStore();
    try {
      const live = await driveLive(store, 'sess-same', [imageResultMessage()]);
      const liveImage = live.find((e) => e.type === 'image_attachment')!.data as ImagePart;

      const messages = await readHistory(store, 'sess-same');
      const historyImage = (messages.find((m) => m.role === 'assistant')!.parts as ImagePart[])[1];

      expect(historyImage.attachmentId).toBe(liveImage.attachmentId);
      expect(historyImage.url).toBe(liveImage.url);
      expect(await readdir(attachmentDir(home, 'sess-same'))).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // THE CASE EVERY REAL NEW SESSION TAKES, and the one the test above cannot
  // reach: it drives both halves with one literal id, so it would stay green
  // even if the two paths keyed storage differently.
  //
  // A brand-new session is asked with the id the caller minted, and `system/init`
  // renames it to the canonical `sdkSessionId` before any tool runs. The history
  // read then arrives with the CANONICAL id — `getSessionSnapshot` resolves
  // `historyId = getInternalSessionId(sessionId) ?? sessionId` and `GET
  // /:id/messages` does the same translation. So live and history genuinely
  // arrive with two different strings, and only a storage key that resolves to
  // the same one for both puts the picture in one place.
  it('stores under the canonical id, so a first turn writes ONE file a reload finds', async () => {
    const { store, home } = makeStore();
    const REQUEST_ID = 'sess-request-id';
    const CANONICAL_ID = 'sess-canonical-id';
    try {
      const live = await driveLive(
        store,
        REQUEST_ID,
        [initMessage(CANONICAL_ID), imageResultMessage()],
        // No canonical id yet — this turn's own init is what names it.
        undefined
      );
      const liveImage = live.find((e) => e.type === 'image_attachment')!.data as ImagePart;

      const messages = await readHistory(store, CANONICAL_ID);
      const historyImage = (messages.find((m) => m.role === 'assistant')!.parts as ImagePart[])[1];

      expect(historyImage.attachmentId).toBe(liveImage.attachmentId);
      expect(historyImage.url).toBe(liveImage.url);
      // One file, under the canonical id, and NOTHING under the request id —
      // the second copy at a different URL is the defect this pins.
      expect(await readdir(attachmentDir(home, CANONICAL_ID))).toHaveLength(1);
      expect(existsSync(attachmentDir(home, REQUEST_ID))).toBe(false);
      expect(liveImage.url).toContain(CANONICAL_ID);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps a still-referenced picture alive against the retention sweep', async () => {
    const { store, home } = makeStore();
    try {
      await readHistory(store, 'sess-touch');
      const dir = attachmentDir(home, 'sess-touch');
      const [file] = await readdir(dir);
      const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
      await utimes(join(dir, file), old, old);

      await readHistory(store, 'sess-touch');
      // `touch` is best-effort and deliberately not awaited on the read path
      // (a failure to refresh a timestamp must not fail the read), so poll for
      // it rather than racing it.
      await vi.waitFor(() =>
        expect(statSync(join(dir, file)).mtimeMs).toBeGreaterThan(old.getTime())
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still shows a row for a picture the sweep already collected', async () => {
    const { store, home } = makeStore();
    try {
      await readHistory(store, 'sess-gone');
      const dir = attachmentDir(home, 'sess-gone');
      const [file] = await readdir(dir);
      await unlink(join(dir, file));

      // Re-reading rewrites it from the transcript's own base64, which is the
      // honest answer here — claude-code records the bytes, unlike a
      // `file://`-sourced OpenCode image. The point is that the turn keeps its
      // picture rather than losing a part.
      const messages = await readHistory(store, 'sess-gone');
      const parts = messages.find((m) => m.role === 'assistant')!.parts!;
      expect(parts.map((p) => p.type)).toEqual(['tool_call', 'image', 'text']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads no images at all when the caller asked for none', () => {
    const messages = parseTranscript(imageTranscriptLines(TOOL_ID));
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.parts?.map((p) => p.type)).toEqual(['tool_call', 'text']);
  });
});
