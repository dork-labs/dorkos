/**
 * Finding the pictures inside a Claude Code tool result — the pure half.
 *
 * **The shape, verified against a real turn rather than inferred.** Reading a
 * PNG with the built-in `Read` tool produces exactly this, both on the live SDK
 * stream (an `SDKUserMessage`) and in the transcript JSONL the same turn writes:
 *
 * ```jsonc
 * { "type": "user", "message": { "role": "user", "content": [
 *     { "type": "tool_result", "tool_use_id": "toolu_…", "content": [
 *       { "type": "image",
 *         "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0…" } }
 *     ] } ] } }
 * ```
 *
 * One shape, two readers — which is why this module exists apart from both of
 * them. `sdk/event-mappers/message-event-mapper.ts` reads the live message and
 * `sessions/transcript-parser.ts` reads the recorded one; before this change
 * each filtered the blocks down to `type === 'text'` and a `Read` of a PNG came
 * out as the empty string. Nothing was logged, nothing was shown, and the
 * default runtime dropped the most ordinary media case there is.
 *
 * **Pure by design, like OpenCode's `part-event-mapper`.** Storing bytes is I/O
 * and both readers are synchronous mappers, so this one records an INTENT and
 * `media-capture.ts` does the writing. See that module for the other half.
 *
 * @module services/runtimes/claude-code/tool-result-images
 */

/**
 * One image block a tool handed back, found but not yet stored.
 *
 * A discriminated union rather than a nullable payload, because the two cases
 * have nothing in common downstream: one becomes a picture, the other becomes a
 * sentence saying why there is no picture.
 */
export type ToolResultImage =
  /** Bytes carried inline, ready to store. */
  | {
      kind: 'bytes';
      /** What the block says the bytes are (`source.media_type`). */
      mediaType: string;
      /** The base64 payload, exactly as the block carried it. */
      base64: string;
      /** How this image is identified within the session. See {@link imageIdentity}. */
      identity: readonly string[];
    }
  /** An image block this machine will not turn into bytes. */
  | {
      kind: 'unreadable';
      /** What a person is told in place of the picture. */
      reason: string;
      /** How this image is identified within the session. See {@link imageIdentity}. */
      identity: readonly string[];
    };

/**
 * The turn-scoped bookkeeping the pure recorder writes and the async drain
 * reads.
 *
 * Lives on `ToolState` for the live path and on a local array for the history
 * path — both are per-turn and per-read respectively, which is the scope
 * {@link ToolResultImageState.recordedKeys} needs to be correct.
 */
export interface ToolResultImageState {
  /** Images found and not yet stored, in the order they appeared. */
  readonly pendingMedia: ToolResultImage[];
  /**
   * Identity keys already recorded — the single-shot guard, and the reason one
   * picture is announced once.
   *
   * Claude Code's own delivery is single-shot: one `tool_result` block per call,
   * once. The guard is here anyway, for two reasons that are not hypothetical.
   * The resume path can re-deliver a turn's messages (`isReplay`, already
   * skipped upstream) and the persistent pump runs many turns through one
   * process, so a redelivered `tool_result` would announce a second picture at
   * the same URL. The store dedupes the BYTES — the attachment id is derived, so
   * two announcements write one file — but the client's fold appends a part per
   * EVENT with no upsert, so two announcements draw two pictures. That is the
   * exact defect the OpenCode adapter shipped and had to fix in review; it costs
   * one `Set` to not repeat it.
   */
  readonly recordedKeys: Set<string>;
}

/** A fresh, empty {@link ToolResultImageState}. */
export function createToolResultImageState(): ToolResultImageState {
  return { pendingMedia: [], recordedKeys: new Set() };
}

/**
 * How one image inside a tool result is named, stably, forever.
 *
 * The tool call's own id plus the block's position in the result. Both survive
 * a re-read of the same transcript unchanged, which is what makes the derived
 * attachment id idempotent: reopening a session after a restart finds the file
 * the first read wrote instead of writing a second copy.
 *
 * @param toolUseId - The `tool_use_id` of the call that returned this result.
 * @param blockIndex - The block's index within the result's content array.
 */
function imageIdentity(toolUseId: string, blockIndex: number): readonly string[] {
  return ['tool', toolUseId, String(blockIndex)];
}

/**
 * A loosely-typed image block, as it arrives from the SDK or off disk.
 *
 * Typed structurally rather than imported: the live path sees
 * `unknown`-shaped SDK content and the history path sees the adapter's own
 * `ContentBlock`, and neither of those declares `source` today. Validating the
 * fields here is what lets both callers hand over whatever they have.
 */
interface RawImageBlock {
  type?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown } | unknown;
}

/**
 * Every image a tool result carried, in block order.
 *
 * Non-image blocks are skipped silently — text is the caller's business and
 * always was. An image block whose source is not inline base64 is NOT skipped:
 * it comes back as `unreadable`, so the reader is told there was a picture
 * rather than being shown a turn that quietly lost one. That is the whole point
 * of this change, and skipping the awkward case would reintroduce it in
 * miniature.
 *
 * @param toolUseId - The `tool_use_id` of the call that returned this result.
 * @param content - The result's `content` field: a string (no images by
 *   definition), a block array, or anything else.
 */
export function extractToolResultImages(toolUseId: string, content: unknown): ToolResultImage[] {
  if (!Array.isArray(content)) return [];
  const images: ToolResultImage[] = [];
  for (const [index, raw] of (content as RawImageBlock[]).entries()) {
    if (raw?.type !== 'image') continue;
    const identity = imageIdentity(toolUseId, index);
    const source = raw.source as { type?: unknown; media_type?: unknown; data?: unknown } | null;
    const mediaType = typeof source?.media_type === 'string' ? source.media_type : '';
    if (
      source?.type === 'base64' &&
      typeof source.data === 'string' &&
      source.data.length > 0 &&
      mediaType.toLowerCase().startsWith('image/')
    ) {
      images.push({ kind: 'bytes', mediaType, base64: source.data, identity });
      continue;
    }
    // A `url` source would mean DorkOS fetching an address a model chose, which
    // is a server-side request forgery with extra steps — the same call
    // `media-capture.ts` makes for OpenCode, made the same way here. Anything
    // else is a block shape nothing on this machine knows how to read.
    images.push({
      kind: 'unreadable',
      reason:
        source?.type === 'url'
          ? 'An image was produced at a web address, which is not fetched from here, so it could not be shown.'
          : 'An image arrived in a form that could not be read, so it was not saved.',
      identity,
    });
  }
  return images;
}

/**
 * Record every image in one tool result, once each.
 *
 * The single-shot guard lives here rather than in {@link extractToolResultImages}
 * so extraction stays a pure function of its arguments and testable without a
 * state object.
 *
 * @param state - The turn's media bookkeeping (mutated).
 * @param toolUseId - The `tool_use_id` of the call that returned this result.
 * @param content - The result's `content` field.
 */
export function recordToolResultImages(
  state: ToolResultImageState,
  toolUseId: string,
  content: unknown
): void {
  for (const image of extractToolResultImages(toolUseId, content)) {
    // NUL-separated, like the OpenCode mapper's guard keys: a `tool_use_id` is
    // SDK-supplied and may contain anything, and a separator that cannot occur
    // inside one is what keeps two different images from hashing to one key.
    const key = image.identity.join('\u0000');
    if (state.recordedKeys.has(key)) continue;
    state.recordedKeys.add(key);
    state.pendingMedia.push(image);
  }
}
