/**
 * @vitest-environment node
 *
 * A picture a tool returned survives the PERSISTENT PUMP, not just the
 * resume-per-message sender (DOR-1664).
 *
 * **This file exists because its absence was invisible.** claude-code has two
 * dispatch paths, and `mapSdkMessageWithMedia` wraps the mapper for both
 * precisely so they cannot drift. Only `message-sender.ts` was covered: reverting
 * `pump-turn-stream.ts` to the bare `mapSdkMessage` — removing media capture from
 * the pump entirely — left the whole server suite green. A wrapper whose stated
 * job is "the two paths behave the same" needs both halves held to it, or the
 * guarantee is a comment rather than a fact.
 *
 * The production mapper runs here unmocked, over the exact `tool_result` shape a
 * real `Read` of a PNG produces, through a REAL attachment store: the claim is
 * that the URL is live on arrival, and only a store that wrote bytes shows that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImagePart, StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../../lib/logger.js';
import { LocalSessionAttachmentStore } from '../../../../session/attachments/local-session-attachment-store.js';
import { deriveSessionAttachmentId } from '../../../../session/attachments/session-attachment-id.js';
import type { MessageSenderOpts } from '../../messaging/message-sender-shared.js';
import type { AgentSession } from '../../agent-types.js';
import { streamTurnWindow } from '../pump-turn-stream.js';
import type { TurnWindow } from '../session-turn-windows.js';
import { TINY_PNG_BASE64 } from '../../__tests__/sdk-scenarios.js';

const SESSION_ID = 'sess-pump-media';
/**
 * What the warm session actually answers to.
 *
 * Deliberately NOT {@link SESSION_ID}: a session on the pump has already been
 * through its first `system/init`, so the id a caller asks with and the
 * canonical `sdkSessionId` are two different strings — and images key on the
 * canonical one, because that is the id every history read arrives with
 * (`claude-code-runtime.ts`, `getMessageHistory`).
 */
const CANONICAL_ID = 'sdk-1';
const TOOL_ID = 'toolu_pump_read_png';
const PUMP_QUERY = {} as Query;

/** A session mid-turn on a warm process. */
function makeSession(): AgentSession {
  return {
    sdkSessionId: CANONICAL_ID,
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    activeQuery: PUMP_QUERY,
  } as unknown as AgentSession;
}

function makeWindow(messages: SDKMessage[]): TurnWindow {
  return {
    ids: ['msg-1'],
    origin: 'user',
    messages: {
      [Symbol.asyncIterator]: async function* () {
        for (const message of messages) yield message;
      },
    },
  };
}

/** The `tool_result` a `Read` of a PNG produces — image block, no text. */
function imageResult(): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TOOL_ID,
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 },
            },
          ],
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: 'user-1',
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

/** The turn's terminal `result`, so the window closes like a real one. */
function successResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: 'result-1',
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

async function runWindow(
  attachments: LocalSessionAttachmentStore | undefined,
  messages: SDKMessage[]
): Promise<StreamEvent[]> {
  const opts: MessageSenderOpts = {
    cwd: '/mock/project',
    onSdkSessionRebind: async () => {},
    ...(attachments ? { attachments } : {}),
  };
  const events: StreamEvent[] = [];
  for await (const event of streamTurnWindow({
    sessionId: SESSION_ID,
    session: makeSession(),
    window: makeWindow(messages),
    opts,
    meshAgentId: undefined,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamTurnWindow — a picture a tool returned (DOR-1664)', () => {
  it('announces the image by URL, with the bytes already on disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dorkos-pump-media-'));
    const store = new LocalSessionAttachmentStore(home);
    try {
      const events = await runWindow(store, [imageResult(), successResult()]);

      const images = events.filter((e) => e.type === 'image_attachment');
      expect(
        images,
        'the persistent pump must keep a picture exactly as the resume path does — ' +
          'this is the half of `mapSdkMessageWithMedia` nothing used to hold'
      ).toHaveLength(1);

      const data = images[0].data as ImagePart;
      expect(data.url.startsWith('data:')).toBe(false);
      expect(data.mediaType).toBe('image/png');
      expect(data.attachmentId).toBe(deriveSessionAttachmentId(['tool', TOOL_ID, '0']));

      // Live on arrival, proven by reading the bytes back — and read back under
      // the CANONICAL id, because that is where the pump must have put them.
      // A history read of this session arrives with that id and nothing else,
      // so bytes under the request id would be a picture nobody can find.
      const stored = await store.get(CANONICAL_ID, data.attachmentId, 'png');
      expect(stored, 'the pump stored this picture under the canonical session id').not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const chunk of stored!.stream) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(TINY_PNG_BASE64, 'base64'));
      expect(
        await store.get(SESSION_ID, data.attachmentId, 'png'),
        'nothing may be written under the id this turn happened to be asked with'
      ).toBeNull();
      expect(data.url).toContain(CANONICAL_ID);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('announces the image before the turn ends', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dorkos-pump-media-order-'));
    try {
      const events = await runWindow(new LocalSessionAttachmentStore(home), [
        imageResult(),
        successResult(),
      ]);
      const types = events.map((e) => e.type);
      expect(types.indexOf('image_attachment')).toBeGreaterThan(-1);
      expect(types.indexOf('image_attachment')).toBeLessThan(types.indexOf('done'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not call a picture-only turn a dead stream', async () => {
    // A `tool_result` carrying only an image maps to no `tool_result` event, so
    // without `image_attachment` counting as content this turn would close with
    // "The agent did not respond" printed under the picture it just produced.
    const home = mkdtempSync(join(tmpdir(), 'dorkos-pump-media-guard-'));
    try {
      const events = await runWindow(new LocalSessionAttachmentStore(home), [
        imageResult(),
        successResult(),
      ]);
      expect(
        events.filter(
          (e) =>
            e.type === 'error' &&
            String((e.data as { message?: string }).message ?? '').includes('did not respond')
        )
      ).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says so out loud when the pump was wired nowhere to keep a picture', async () => {
    const events = await runWindow(undefined, [imageResult(), successResult()]);
    expect(events.filter((e) => e.type === 'image_attachment')).toEqual([]);
    expect(
      events.filter((e) => (e.data as { code?: string }).code === 'SESSION_IMAGE_NOT_STORED')
    ).toHaveLength(1);
  });
});
