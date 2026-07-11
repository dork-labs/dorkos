import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SessionStreamState } from '@/layers/entities/session';

/** The newest ` ```dorkos-ui ` fence found in a session's projected message stream. */
export interface LatestWidgetFence {
  /** The fence's raw body (not yet parsed — feed to `WidgetFence`, which owns parsing). */
  code: string;
  /** True when the fence has no closing delimiter yet (still streaming open). */
  isIncomplete: boolean;
  /** Stable identifier of the message the fence came from (for keying/testing). */
  sourceMessageKey: string;
  /** True when the source message is the newest message in the session's projection. */
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

/** Opening fence marker for a `dorkos-ui` widget document. Any match is enough — no full markdown parse. */
const FENCE_OPEN_MARKER = '```dorkos-ui';

/** A closing markdown fence line. */
const FENCE_CLOSE_LINE = '```';

/** One entry in the locally-derived, oldest-first message projection scanned for fences. */
interface VirtualMessage {
  key: string;
  content: string;
  isStreaming: boolean;
}

/**
 * `SessionEvent` types that UNCONDITIONALLY fold into a renderable part of the
 * trailing in-progress assistant bubble.
 *
 * PARITY SOURCE: mirrors (without importing — `fsd-layers.md` forbids
 * cross-feature model imports) `projectInProgressTurn` + `buildInProgressMessage`
 * in `features/chat/model/stream/project-session-turn.ts`. Keep this set in sync
 * when that fold gains or loses part-producing event types. Deliberately absent:
 * `hook_update` and `interaction_resolved` only mutate parts OTHER events
 * created (or are buffered/dropped), so they never independently create the
 * bubble; `operation_progress` is conditional (see
 * {@link eventProducesRenderablePart}); `turn_start`, `turn_end`,
 * `status_change`, `todo_update`, and `system_status` carry no renderable part.
 */
const RENDERABLE_TURN_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'text_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'tool_progress',
  'approval_required',
  'question_prompt',
  'elicitation_prompt',
  'subagent_update',
  'memory_recall',
  'compact_boundary',
  'error',
]);

/**
 * Whether a single in-progress-turn event folds into a renderable part in the
 * inline projection. `operation_progress` produces a part only for a FAILED
 * compaction (its other phases drive the transient status strip, not the
 * bubble) — mirrors `foldOperationProgress` in `project-session-turn.ts`.
 */
function eventProducesRenderablePart(event: SessionEvent): boolean {
  if (event.type === 'operation_progress') {
    return event.operation === 'compaction' && event.state === 'failed';
  }
  return RENDERABLE_TURN_EVENT_TYPES.has(event.type);
}

/**
 * Re-derive, locally within `gen-ui`, the minimal oldest-first slice of
 * `projectSessionMessages`'s composition this scanner needs: completed history,
 * then the optimistic user message, then the folded in-progress assistant text.
 * `fsd-layers.md` forbids importing `features/chat`'s model code from another
 * feature's model/lib, so this independently mirrors that same ordering instead.
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
  // The inline projection appends the trailing assistant bubble whenever the
  // turn folds ANY renderable part (thinking, tool calls, subagents, ...) or a
  // pending interaction card — not only text (parity: `buildInProgressMessage`
  // + `foldPendingInteractions` in `project-session-turn.ts`). A text-less
  // bubble still occupies the newest-message SLOT, so it must supersede an
  // older board here too; the scanner only ever searches the TEXT for fences,
  // and an empty-content entry simply carries none.
  const turnRendersBubble =
    inProgressText.length > 0 ||
    state.pendingInteractions.length > 0 ||
    state.inProgressTurn.some(eventProducesRenderablePart);
  if (turnRendersBubble) {
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
  const markerIndex = content.lastIndexOf(FENCE_OPEN_MARKER);
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
 * Newest-message-wins: the search walks the locally-derived, oldest-first
 * virtual message list (completed history, then the optimistic user message,
 * then the folded in-progress assistant text — mirroring `MessageList.tsx`'s
 * positional `isLatestMessage` rule) newest-first, and returns the fence from
 * the first message that carries one, even if an older message also has one.
 * Within that message, the LAST fence wins when more than one is present. A
 * fence with no closing delimiter yet (including one still streaming in via
 * `inProgressTurn`) is returned with `isIncomplete: true`.
 *
 * @param state - The session's projected stream state (or the relevant slices of it).
 * @returns The newest fence found, or `null` when no virtual message contains one.
 */
export function findLatestWidgetFence(state: SessionStreamState): LatestWidgetFence | null {
  const virtualMessages = buildVirtualMessages(state);

  for (let index = virtualMessages.length - 1; index >= 0; index--) {
    const message = virtualMessages[index];
    if (!message.content.includes(FENCE_OPEN_MARKER)) continue;

    const { code, isIncomplete } = extractLastFenceBody(message.content);
    return {
      code,
      isIncomplete,
      sourceMessageKey: message.key,
      isLatest: index === virtualMessages.length - 1,
      isStreaming: message.key === IN_PROGRESS_TURN_KEY,
    };
  }

  return null;
}
