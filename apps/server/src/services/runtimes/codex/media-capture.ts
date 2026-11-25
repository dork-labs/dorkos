/**
 * Turning an image an MCP tool handed Codex into a DorkOS image.
 *
 * **Codex cannot stream a picture it generated, and no amount of adapter code
 * changes that.** `@openai/codex-sdk@0.163.0`'s `ThreadItem` union is
 * `AgentMessageItem | ReasoningItem | CommandExecutionItem | FileChangeItem |
 * McpToolCallItem | WebSearchItem | TodoListItem | ErrorItem` — there is no
 * image output item of any kind. `type: "local_image"` exists in that SDK, but
 * only on `UserInput`, which is the INPUT direction (attaching a picture TO a
 * turn) and a separate piece of work. So an MCP tool result is Codex's ONE media
 * path today, and this module is all of it. Anyone looking for a
 * generated-image branch here should stop looking: there is nothing upstream to
 * branch on.
 *
 * What arrives is MCP's own `ImageContent` — `{ type: 'image', data: '<base64>',
 * mimeType }` — inside `McpToolCallItem.result.content`. `extractMcpResultText`
 * filtered that array down to `block.type === 'text'`, so a tool that answered
 * with a screenshot answered with nothing.
 *
 * Same pure/async split as `runtimes/opencode/events/media-capture.ts`: `event-mapper`
 * is synchronous and records an INTENT on the per-turn context; this drains
 * those intents from the runtime's own async turn loop, writes the bytes through
 * the {@link SessionAttachmentStore}, and yields the `image_attachment` events.
 * No base64 payload ever exists as a StreamEvent.
 *
 * @module services/runtimes/codex/media-capture
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import { logger } from '../../../lib/logger.js';
import { decodeBase64Image, storeCapturedImage } from '../shared/media-capture.js';

/** One image an MCP tool returned, recorded by the pure mapper and not yet stored. */
export interface CodexMediaIntent {
  /** What the block says the bytes are (MCP `ImageContent.mimeType`). */
  mediaType: string;
  /** The base64 payload, exactly as the block carried it. */
  base64: string;
  /**
   * How Codex identifies this image within the session, most-significant first:
   * the `mcp_tool_call` item's id plus the block's position in the result.
   * Hashed into the attachment id, so the same picture met again lands at the
   * same URL rather than being written a second time.
   */
  identity: readonly string[];
}

/** The slice of a turn's mapping context this module owns. */
export interface CodexMediaState {
  /**
   * Images the mapper has seen and not yet stored, in the order they appeared.
   * Drained by {@link captureCodexMedia} after every mapped thread event.
   */
  readonly pendingMedia: CodexMediaIntent[];
  /**
   * Identity keys already recorded this turn — the single-shot guard, and the
   * reason one picture is announced once.
   *
   * Codex delivers an item through `item.started` → `item.updated` →
   * `item.completed`, and the recorder only fires on `completed`, so ordinarily
   * one image is recorded once. The guard is the same one `startedToolIds`
   * already provides for the tool pair, and for the same reason: a repeated
   * terminal phase would announce a second picture. The store dedupes the BYTES
   * (the attachment id is derived, so two announcements write one file) but the
   * client's fold appends a part per EVENT with no upsert, so two announcements
   * draw two pictures. That is the defect the OpenCode adapter shipped and had
   * to fix in review.
   */
  readonly recordedMediaKeys: Set<string>;
}

/**
 * Record every image one completed MCP tool call returned, once each.
 *
 * Pure: it reads the item and writes the context, and does no I/O — which is
 * why it lives beside the drain rather than inside it.
 *
 * @param state - The turn's media bookkeeping (mutated).
 * @param itemId - The `mcp_tool_call` item's id.
 * @param content - `McpToolCallItem.result.content`, MCP's own block array.
 */
export function recordCodexMedia(state: CodexMediaState, itemId: string, content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const [index, raw] of content.entries()) {
    const block = raw as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (block?.type !== 'image') continue;
    const mediaType = typeof block.mimeType === 'string' ? block.mimeType : '';
    if (typeof block.data !== 'string' || block.data.length === 0) continue;
    if (!mediaType.toLowerCase().startsWith('image/')) continue;
    const identity = ['mcp', itemId, String(index)] as const;
    // NUL-separated, like `endedToolCallIds` keys in the OpenCode mapper: an
    // item id is server-supplied and may contain anything, and a separator that
    // cannot occur inside one is what keeps two different images from hashing
    // to one key.
    const key = identity.join('\u0000');
    if (state.recordedMediaKeys.has(key)) continue;
    state.recordedMediaKeys.add(key);
    state.pendingMedia.push({ mediaType, base64: block.data, identity });
  }
}

/**
 * Drain every pending image, store it, and yield its `image_attachment` event.
 *
 * Drains destructively and completely, so an event that is yielded is one whose
 * bytes are already fetchable — a client never sees a reference to something
 * that is not there yet.
 *
 * **Failures degrade to a sentence, never to silence.** Bytes past the cap or a
 * media type a session may not store yield a typed `error` StreamEvent saying
 * what could not be shown; swapping one silent drop for another would miss the
 * point of the change entirely.
 *
 * @param store - Where the bytes go, or `null` when the runtime was wired
 *   without one. With no store there is nothing honest to do but say so once per
 *   image — and the runtime declares `mediaOutput: 'none'` in that
 *   configuration, so nothing was promised.
 * @param sessionId - The DorkOS session the images belong to.
 * @param state - The turn's media bookkeeping (drained).
 */
export async function* captureCodexMedia(
  store: SessionAttachmentStore | null,
  sessionId: string,
  state: CodexMediaState
): AsyncGenerator<StreamEvent> {
  while (state.pendingMedia.length > 0) {
    const intent = state.pendingMedia.shift()!;
    yield await storeCapturedImage(
      store,
      sessionId,
      {
        identity: intent.identity,
        mediaType: intent.mediaType,
        bytes: () => decodeBase64Image(intent.base64),
      },
      (err) =>
        logger.warn('[CodexRuntime] could not store an image a tool returned', { err, sessionId })
    );
  }
}
