/**
 * What kind of frame the CLI just produced, as the turn windower asks it:
 * whether it starts a turn, whether a person would see it, and whether it is a
 * helper's rather than the agent's own.
 *
 * Split out of `../session-turn-windows.ts`, which is the only reader of all three
 * and is over the file-size limit. The rules that act on the answers stay there.
 *
 * @module services/runtimes/claude-code/sessions/frames/frame-kinds
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Whether this frame comes from a helper (a subagent the agent started with the
 * Task tool) rather than from the agent's own main thread.
 *
 * The CLI stamps `parent_tool_use_id` with the Task call's id on every frame a
 * helper produces: its complete `assistant` messages, its `stream_event`
 * partials, its `user` tool results and its `tool_progress` lines. Main-thread
 * frames carry `null`, and frame kinds that never come from a helper do not
 * carry the field at all.
 *
 * @param message - The message the process just produced
 */
export function isHelperFrame(message: SDKMessage): boolean {
  return Boolean((message as { parent_tool_use_id?: unknown }).parent_tool_use_id);
}

/**
 * Whether this message is the CLI STARTING a turn, rather than bookkeeping it
 * emits between them.
 *
 * Two shapes prove it: a main-thread `assistant`, and the main-thread
 * `stream_event` partials that carry one. A turn's own work is always preceded
 * by an `assistant` — a tool call is an `assistant` message before it is a
 * `user` tool result — so within a turn this is a sound signal.
 *
 * **A helper's frames never count (DOR-2698).** A background helper keeps
 * working after its parent's reply ends, and its frames are `assistant` and
 * `stream_event` too. Read as a turn starting, the helper's first word opened an
 * agent-started turn that stayed open for the helper's whole run: the chat
 * showed the agent working on a turn it never started, and that turn held the
 * session's queue. The helper's report reaches the agent as a notification the
 * CLI answers in a segment of its own, on the main thread, and THAT is the turn
 * that starts.
 *
 * **It is not a complete signal, and the caller does not treat it as one.** The
 * CLI emits frames BEFORE a continuation's first word that are not content at
 * all: an `api_retry` when the continuation's first request is retried, an
 * `auto` `compact_boundary` taken to make room for the steer's turn. Reading a
 * `false` here as "no continuation is coming" lost exactly those (DOR-1314
 * review, probe D). So a `false` does not close anything on its own — it means
 * "not yet proven", and the windower's `onMessage` answers it by re-arming the
 * grace within the cap rather than by letting the clock run out. A helper's
 * frame is answered the same way: proof the process is alive, not proof the
 * agent's continuation began.
 *
 * The two shapes deliberately excluded are the ones the windower's module doc
 * names as routine between-turn traffic: a `system` line, and the `user` tool
 * result of a tool that was still running when its turn ended. That late tool
 * result belongs to the turn that JUST FINISHED, so it is not evidence a new one
 * began — but it IS evidence the process is alive, which is why it re-arms.
 * The two answers are different questions and the split is the whole point:
 * only content stops the clock, anything else merely postpones it.
 *
 * @param message - The message the process just produced
 */
export function beginsATurn(message: SDKMessage): boolean {
  if (isHelperFrame(message)) return false;
  return message.type === 'assistant' || message.type === 'stream_event';
}

/** Delta types the stream mapper turns into `text_delta` or `thinking_delta`. */
const VISIBLE_DELTA_TYPES: ReadonlySet<string> = new Set(['text_delta', 'thinking_delta']);

/**
 * Whether a `stream_event` maps to a content event: a text or thinking delta, or
 * a `tool_use` block starting (`tool_call_start`). A `server_tool_use` start,
 * `message_start`, `ping` and block stops map to nothing the guard counts.
 *
 * @param message - A `stream_event` from the main thread
 */
function streamEventCarriesContent(message: SDKMessage): boolean {
  const event = (
    message as { event?: { type?: unknown; delta?: unknown; content_block?: unknown } }
  ).event;
  if (event?.type === 'content_block_delta') {
    const deltaType = (event.delta as { type?: unknown } | undefined)?.type;
    return typeof deltaType === 'string' && VISIBLE_DELTA_TYPES.has(deltaType);
  }
  if (event?.type === 'content_block_start') {
    return (event.content_block as { type?: unknown } | undefined)?.type === 'tool_use';
  }
  return false;
}

/**
 * Whether a `user` message maps to a `tool_result`: a live (not replayed)
 * message whose block list holds a tool result naming its call.
 *
 * @param message - A `user` message from the main thread
 */
function userMessageCarriesToolResult(message: SDKMessage): boolean {
  if ((message as { isReplay?: unknown }).isReplay) return false;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: unknown; tool_use_id?: unknown } | null;
    return b?.type === 'tool_result' && typeof b.tool_use_id === 'string';
  });
}

/**
 * Whether this frame carries something a person can see: the question the
 * empty-stream guard (`shared/empty-stream-guard.ts`) asks of the MAPPED
 * events, asked here of the raw frame so the two layers agree (DOR-2064).
 * `session-turn-windows-content-parity.test.ts` pushes every shape through the
 * production mapper and fails the moment the two answers part.
 *
 * What counts, row for row with the mappers:
 *
 * - a main-thread `stream_event` text or thinking delta, or a `tool_use` start;
 * - a main-thread, non-replayed `user` message carrying a tool result;
 * - a `tool_use_summary` naming at least one call (each becomes a `tool_result`);
 * - a MANUAL `compact_boundary`, which is the whole answer to `/compact`.
 *
 * What does not: anything forwarded from a helper ({@link isHelperFrame}), a
 * complete `assistant` message (the live text already arrived as deltas, so the
 * mapper yields only bookkeeping for it), an automatic compaction, and every
 * other `system` line. Image attachments are announced from a tool result that
 * already counts, so they need no row of their own here.
 *
 * @param message - The message the process just produced
 * @internal Exported for the windower and the parity test.
 */
export function carriesVisibleContent(message: SDKMessage): boolean {
  if (isHelperFrame(message)) return false;
  switch (message.type) {
    case 'stream_event':
      return streamEventCarriesContent(message);
    case 'user':
      return userMessageCarriesToolResult(message);
    case 'tool_use_summary': {
      const calls = (message as { preceding_tool_use_ids?: unknown }).preceding_tool_use_ids;
      return Array.isArray(calls) && calls.length > 0;
    }
    case 'system':
      return (
        (message as { subtype?: unknown }).subtype === 'compact_boundary' &&
        (message as { compact_metadata?: { trigger?: unknown } }).compact_metadata?.trigger ===
          'manual'
      );
    default:
      return false;
  }
}
