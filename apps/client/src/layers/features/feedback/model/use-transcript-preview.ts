/**
 * Client-side preview of the transcript excerpt a bug report will attach
 * (feedback-pipeline spec Part 5, design-decisions §5-6).
 *
 * The authoritative excerpt is gathered and scrubbed SERVER-SIDE at send time
 * (`apps/server/src/lib/transcript-excerpt.ts`). This hook reads the same recent
 * history the server would and formats it with the same bounds and scrubbing, so
 * the preview shows the user a faithful approximation of what leaves their
 * machine BEFORE they press Send — the mechanism that keeps "Send is the
 * consent" honest. It is a preview, not the wire bytes: the server re-gathers and
 * re-scrubs authoritatively, so a session that changed between preview and send
 * is still bounded and scrubbed on the server.
 *
 * @module features/feedback/model/use-transcript-preview
 */
import { useQuery } from '@tanstack/react-query';
import { redactPaths, redactTokens } from '@dorkos/shared/error-report';
import { MAX_TRANSCRIPT_LEN } from '@dorkos/shared/telemetry-events';
import type { HistoryMessage } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { useDirectoryState } from '@/layers/entities/session';

// These two bounds mirror `apps/server/src/lib/transcript-excerpt.ts`, which is
// server-only and not client-importable. They must stay in sync with that file
// so the preview reflects what the server actually gathers; the whole-excerpt
// `MAX_TRANSCRIPT_LEN` cap below is imported from the shared package (the single
// source of truth) rather than mirrored.

/** Trailing messages the preview keeps (~10 turns) — mirrors the server default. */
const PREVIEW_MAX_MESSAGES = 20;

/** Per-tool input/result character cap before trimming — mirrors the server. */
const PREVIEW_MAX_TOOL_OUTPUT_CHARS = 500;

/** Trim one long tool input/result, marking the cut (mirrors the server). */
function trimToolOutput(value: string): string {
  const collapsed = value.trim();
  return collapsed.length > PREVIEW_MAX_TOOL_OUTPUT_CHARS
    ? `${collapsed.slice(0, PREVIEW_MAX_TOOL_OUTPUT_CHARS)}… [trimmed]`
    : collapsed;
}

/** Format one message (plus its tool calls) into readable preview lines. */
function formatMessage(message: HistoryMessage): string {
  const lines: string[] = [`${message.role}: ${message.content.trim()}`.trim()];
  for (const tool of message.toolCalls ?? []) {
    lines.push(`  [tool: ${tool.toolName}]`);
    if (tool.input) lines.push(`    input: ${trimToolOutput(tool.input)}`);
    if (tool.result) lines.push(`    result: ${trimToolOutput(tool.result)}`);
  }
  return lines.join('\n');
}

/** Build the bounded, scrubbed preview string from a session's message history. */
function buildPreview(messages: HistoryMessage[]): string {
  const recent = messages.slice(-PREVIEW_MAX_MESSAGES);
  const scrubbed = redactTokens(redactPaths(recent.map(formatMessage).join('\n\n'))).trim();
  // Apply the same whole-excerpt hard cap the server applies, so the preview
  // never shows MORE than what is actually sent (reserve one char for the
  // ellipsis, matching `transcript-excerpt.ts`).
  return scrubbed.length > MAX_TRANSCRIPT_LEN
    ? `${scrubbed.slice(0, MAX_TRANSCRIPT_LEN - 1)}…`
    : scrubbed;
}

/** What {@link useTranscriptPreview} returns. */
export interface TranscriptPreview {
  /** The scrubbed, bounded preview text (empty when there is nothing to show). */
  text: string;
  /** True while the recent history is loading. */
  isLoading: boolean;
  /** True when the history read failed. */
  isError: boolean;
}

/**
 * Load and format a faithful preview of the transcript excerpt that would be
 * attached for the given session.
 *
 * @param sessionId - The session whose recent turns to preview, or `undefined`.
 * @param enabled - Only reads when `true` (the preview surface is open on the
 *   Conversation tab), so a closed preview never fetches.
 * @returns The preview text plus loading/error flags.
 */
export function useTranscriptPreview(
  sessionId: string | undefined,
  enabled: boolean
): TranscriptPreview {
  const transport = useTransport();
  const [cwd] = useDirectoryState();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['feedback-transcript-preview', sessionId, cwd],
    queryFn: async () => {
      const { messages } = await transport.getMessages(sessionId as string, cwd ?? undefined);
      return buildPreview(messages);
    },
    enabled: enabled && Boolean(sessionId),
    staleTime: 30 * 1000,
  });

  return { text: data ?? '', isLoading, isError };
}
