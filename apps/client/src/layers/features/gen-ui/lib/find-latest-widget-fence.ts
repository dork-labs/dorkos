import type { SessionStreamState } from '@/layers/entities/session';

/** The newest ` ```dorkos-ui ` fence found in a session's projected message stream. */
export interface LatestWidgetFence {
  /** The fence's raw body (not yet parsed — feed to `WidgetFence`, which owns parsing). */
  code: string;
  /** True when the fence has no closing delimiter yet (still streaming open). */
  isIncomplete: boolean;
  /** Stable identifier of the message the fence came from (for keying/testing). */
  sourceMessageKey: string;
  /**
   * Whether this fence may still be played. Supersede is FENCE-based (DOR-302):
   * a widget goes stale only when a NEWER fence-bearing message exists — plain
   * trailing agent text ("your move!", a follow-up answer) never freezes it.
   * The scanner returns the session's newest fence by construction, so this is
   * always `true`; the field stays because the `WidgetFence` render contract
   * consumes it (`isLatestMessage`).
   */
  isLatest: boolean;
  /** True when the source message is the trailing in-progress (still-streaming) turn. */
  isStreaming: boolean;
}

/**
 * Synthetic key for the optimistically-rendered user message, mirroring (without
 * importing) `OPTIMISTIC_USER_ID` in `features/chat/model/stream/project-session-turn.ts`.
 */
const OPTIMISTIC_USER_KEY = '__optimistic_user__';

/**
 * Synthetic key for the trailing in-progress assistant turn, mirroring (without
 * importing) `IN_PROGRESS_ASSISTANT_ID` in `features/chat/model/stream/project-session-turn.ts`.
 */
const IN_PROGRESS_TURN_KEY = '__in_progress_turn__';

/**
 * Opening fence marker for a `dorkos-ui` widget document. Any match is enough —
 * no full markdown parse. Exported so the inline chat path (`MessageList`) can
 * compute its newest-fence-bearing-message index with the same marker.
 */
export const WIDGET_FENCE_MARKER = '```dorkos-ui';

/** A closing markdown fence line. */
const FENCE_CLOSE_LINE = '```';

/** One entry in the locally-derived, oldest-first message projection scanned for fences. */
interface VirtualMessage {
  key: string;
  content: string;
  isStreaming: boolean;
}

/**
 * Re-derive, locally within `gen-ui`, the minimal oldest-first slice of
 * `projectSessionMessages`'s composition this scanner needs: completed history,
 * then the optimistic user message, then the in-progress assistant text (when
 * any has streamed). `fsd-layers.md` forbids importing `features/chat`'s model
 * code from another feature's model/lib, so this independently mirrors that
 * same ordering instead.
 */
function buildVirtualMessages(state: SessionStreamState): VirtualMessage[] {
  const virtualMessages: VirtualMessage[] = state.messages.map((message) => ({
    key: message.id,
    content: message.content,
    isStreaming: false,
  }));

  if (state.optimisticUserMessage) {
    virtualMessages.push({
      key: OPTIMISTIC_USER_KEY,
      content: state.optimisticUserMessage.content,
      isStreaming: false,
    });
  }

  const inProgressText = state.inProgressTurn
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
  // Only the trailing turn's TEXT can carry a fence, so the streaming bubble
  // joins the projection only when text exists. (Supersede is fence-based —
  // DOR-302 — so a text-less bubble no longer matters here: it can neither
  // carry a fence nor, by occupying the newest-message slot, freeze an older
  // board the way the retired positional rule did.)
  if (inProgressText.length > 0) {
    virtualMessages.push({
      key: IN_PROGRESS_TURN_KEY,
      content: inProgressText,
      isStreaming: true,
    });
  }

  return virtualMessages;
}

/** Strip a single trailing `\r` (CRLF transcripts) so code lines come out clean. */
function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Extract the LAST ` ```dorkos-ui ` fence body within a single message's content.
 * The body runs from the end of the marker's line up to the next line that is a
 * closing ` ``` ` fence (compared after `trimEnd()`, so CRLF line endings and
 * trailing whitespace don't hide the close), or end-of-string if none follows.
 */
function extractLastFenceBody(content: string): { code: string; isIncomplete: boolean } {
  const markerIndex = content.lastIndexOf(WIDGET_FENCE_MARKER);
  const markerLineEnd = content.indexOf('\n', markerIndex);
  const bodyStart = markerLineEnd === -1 ? content.length : markerLineEnd + 1;
  const body = content.slice(bodyStart);

  const lines = body.split('\n');
  const closeLineIndex = lines.findIndex((line) => line.trimEnd() === FENCE_CLOSE_LINE);
  const codeLines = closeLineIndex === -1 ? lines : lines.slice(0, closeLineIndex);
  return {
    code: codeLines.map(stripTrailingCr).join('\n'),
    isIncomplete: closeLineIndex === -1,
  };
}

/**
 * Scan a session's stream state for its newest ` ```dorkos-ui ` widget fence, so
 * the PIP view (task 2.2) can render "whatever board the agent posted most
 * recently" without duplicating `features/chat`'s message-array composition.
 *
 * Newest-fence-wins: the search walks the locally-derived, oldest-first virtual
 * message list (completed history, then the optimistic user message, then the
 * in-progress assistant text) newest-first, and returns the fence from the
 * first message that carries one, even if an older message also has one.
 * Within that message, the LAST fence wins when more than one is present. A
 * fence with no closing delimiter yet (including one still streaming in via
 * `inProgressTurn`) is returned with `isIncomplete: true`.
 *
 * Supersede is fence-based (DOR-302, matching the inline chat path): only a
 * newer FENCE-BEARING message stales a board, so a trailing text-only reply
 * ("opened it!") never freezes the fence this returns — hence `isLatest: true`.
 *
 * @param state - The session's projected stream state (or the relevant slices of it).
 * @returns The newest fence found, or `null` when no virtual message contains one.
 */
export function findLatestWidgetFence(state: SessionStreamState): LatestWidgetFence | null {
  const virtualMessages = buildVirtualMessages(state);

  for (let index = virtualMessages.length - 1; index >= 0; index--) {
    const message = virtualMessages[index];
    if (!message.content.includes(WIDGET_FENCE_MARKER)) continue;

    const { code, isIncomplete } = extractLastFenceBody(message.content);
    return {
      code,
      isIncomplete,
      sourceMessageKey: message.key,
      // By construction the newest fence in the session — no newer fence can
      // exist to supersede it (see the LatestWidgetFence.isLatest contract).
      isLatest: true,
      isStreaming: message.key === IN_PROGRESS_TURN_KEY,
    };
  }

  return null;
}
