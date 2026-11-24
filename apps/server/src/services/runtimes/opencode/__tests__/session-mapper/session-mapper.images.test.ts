/**
 * session-mapper: images. Shared setup lives in `./session-mapper.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Part } from '@opencode-ai/sdk';
import { OpenCodeSessionMapper } from '../../sessions/session-mapper.js';
import {
  PROJECT_DIR,
  DORKOS_ID,
  CREATED_MS,
  ocSession,
  assistantMessage,
  createMockClient,
  type MockClient,
  createProvider,
} from './session-mapper.fixtures.js';

// SDK-only access guard (ADR-0308: OpenCode's store is opaque, runtime-owned).
// The mapper must reach session data exclusively through the SDK client — if it
// (or anything in its runtime import graph) ever imports the filesystem, these
// throwing factories fail the suite at module load.
//
// A `vi.mock` reaches the WHOLE module graph, not just the mapper's, so the
// vectors above come from their own subpath rather than the `@dorkos/test-utils`
// barrel. The barrel re-exports the runtime conformance suite, which legitimately
// resolves real paths, and pulling it in here would fail this file for something
// that is not the mapper and not in the mapper's graph at all.
vi.mock('node:fs', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});

vi.mock('node:fs/promises', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});

/**
 * History and images.
 *
 * The old mapper handled text, reasoning and tool parts and returned `null` for
 * a message that produced none — so a turn whose ONLY part was an image did not
 * merely lose its picture, it disappeared from the transcript entirely. These
 * cases pin both halves of the fix: the picture maps, and the turn survives.
 *
 * The store is faked in memory rather than being the real one, because this
 * module's import graph is filesystem-free by test guard (ADR-0308) — which is
 * also why the mapper takes the store as an injected port and imports only the
 * id derivation, which needs nothing but `node:crypto`.
 */
describe('getMessageHistory — images', () => {
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /** An in-memory `SessionAttachmentStore`, honest about idempotency. */
  function createFakeAttachmentStore() {
    const files = new Map<string, { mediaType: string; size: number }>();
    return {
      files,
      put: vi.fn(
        async (sessionId: string, attachmentId: string, mediaType: string, bytes: Buffer) => {
          const record = { mediaType, size: bytes.byteLength };
          files.set(`${sessionId}/${attachmentId}`, record);
          return { url: `/api/sessions/${sessionId}/attachments/${attachmentId}.png`, ...record };
        }
      ),
      get: vi.fn(async () => null),
      peek: vi.fn(async (sessionId: string, attachmentId: string) => {
        const record = files.get(`${sessionId}/${attachmentId}`);
        if (!record) return null;
        return { url: `/api/sessions/${sessionId}/attachments/${attachmentId}.png`, ...record };
      }),
      touch: vi.fn(async () => {}),
      // Answers a URL whether or not the bytes are there — that is the whole
      // point of it, and what lets an unresolvable image still project a part.
      urlFor: vi.fn(
        (sessionId: string, attachmentId: string) =>
          `/api/sessions/${sessionId}/attachments/${attachmentId}.png`
      ),
    };
  }

  /** A `file` part in the shape OpenCode publishes. */
  function ocFilePart(id: string, overrides: Partial<Extract<Part, { type: 'file' }>> = {}): Part {
    return {
      id,
      sessionID: 'ses_abc123',
      messageID: 'msg_asst1',
      type: 'file',
      mime: 'image/png',
      url: TINY_PNG,
      ...overrides,
    } as Part;
  }

  /** Serve one assistant message with the given parts. */
  function serveAssistant(client: MockClient, parts: Part[]) {
    client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
    client.session.messages.mockResolvedValue({
      data: [{ info: assistantMessage(), parts }],
    });
  }

  it('a turn whose ONLY part is an image no longer vanishes — it comes back WITH the image', async () => {
    const client = createMockClient();
    serveAssistant(client, [ocFilePart('prt_gen01', { filename: 'banana.png' })]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(history).toHaveLength(1);
    expect(history[0]!.parts).toEqual([
      {
        type: 'image',
        attachmentId: expect.stringMatching(/^[0-9a-f]{32}$/),
        url: expect.stringContaining('/attachments/'),
        mediaType: 'image/png',
        size: expect.any(Number),
        alt: 'banana.png',
      },
    ]);
  });

  it('a turn whose only output is an UNSTORABLE image type survives as a typed error part (DOR-1671)', async () => {
    // SVG is refused by the store deliberately (serving it inline is a
    // stored-XSS vector). The fix is not to allow it — it is to keep the turn,
    // as the SAME typed error the live path shows for this condition, never as
    // prose that reads like the agent said it. The raw SVG bytes must never
    // ride along, and the mime is sanitized before display (it is
    // producer-controlled).
    const client = createMockClient();
    serveAssistant(client, [
      ocFilePart('prt_svg01', {
        mime: 'image/svg+xml; a=<img src="https://evil.example/beacon.png">',
        url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        filename: 'diagram.svg',
      }),
    ]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(history).toHaveLength(1);
    expect(history[0]!.parts).toEqual([
      {
        type: 'error',
        message: 'A chat cannot store image/svg+xml — only PNG, JPEG, GIF and WebP images.',
        category: 'execution_error',
      },
    ]);
    const serialized = JSON.stringify(history[0]!.parts);
    expect(serialized).not.toContain('base64');
    expect(serialized).not.toContain('evil.example');
    // An error part never becomes the message content, so nothing here can be
    // quoted back in an excerpt as the agent's own words.
    expect(history[0]!.content).toBe('');
  });

  it('re-materializes an image a tool returned, from `attachments`', async () => {
    const client = createMockClient();
    serveAssistant(client, [
      {
        id: 'prt_tool1',
        sessionID: 'ses_abc123',
        messageID: 'msg_asst1',
        type: 'tool',
        callID: 'call_1',
        tool: 'screenshot',
        state: {
          status: 'completed',
          input: {},
          output: 'captured',
          title: 'screenshot',
          metadata: {},
          attachments: [ocFilePart('prt_f1', { filename: 'shot.png' })],
          time: { start: CREATED_MS, end: CREATED_MS + 100 },
        },
      } as Part,
    ]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(message!.parts?.map((p) => p.type)).toEqual(['tool_call', 'image']);
  });

  it('keeps the turn when the bytes are gone, showing an unavailable image rather than nothing', async () => {
    // The retention sweep can collect a `file://`-sourced image, and this
    // module may not read the disk (ADR-0308) so it cannot rebuild one. Before
    // the placeholder, that resolved to `null`, the message mapped to no parts,
    // and `mapHistoryMessage` dropped the WHOLE TURN — the exact defect this
    // change exists to fix, recreated by its own sweep.
    const client = createMockClient();
    serveAssistant(client, [
      ocFilePart('prt_gen01', { url: 'file:///tmp/swept-away.png', filename: 'banana.png' }),
    ]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(history).toHaveLength(1);
    expect(history[0]!.parts).toEqual([
      {
        type: 'image',
        attachmentId: expect.stringMatching(/^[0-9a-f]{32}$/),
        url: expect.stringContaining('/attachments/'),
        mediaType: 'image/png',
        size: 0,
        alt: 'banana.png',
      },
    ]);
    // Nothing was written — the placeholder is a reference to bytes that are
    // not there, which is what makes the fetch 404 into the honest chip.
    expect(attachments.put).not.toHaveBeenCalled();
  });

  it('touches an image the transcript still references, so retention reads it as in use', async () => {
    // `peek` is a `stat` and deliberately skips the write, so mtime would never
    // move again after the first write and a transcript reopened every day for
    // ninety days would still lose its picture on day ninety.
    const client = createMockClient();
    serveAssistant(client, [ocFilePart('prt_gen01')]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID); // first read writes
    expect(attachments.touch).not.toHaveBeenCalled();
    await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID); // second read finds it

    expect(attachments.touch).toHaveBeenCalledWith(
      DORKOS_ID,
      expect.stringMatching(/^[0-9a-f]{32}$/),
      'png'
    );
  });
});
