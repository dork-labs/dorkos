/**
 * Session transcript excerpt for bug reports (feedback-pipeline spec Parts 5-6).
 *
 * The sibling of `log-excerpt.ts`: where that gathers recent server logs, this
 * gathers a bounded slice of the recent conversation a bug report points at.
 * When the dialog's "Conversation" toggle is on, the client sends `sessionId` +
 * `includeTranscript` and the feedback route calls
 * {@link getSessionTranscriptExcerpt} to build the excerpt SERVER-SIDE — the
 * client never truncates or scrubs the transcript itself (the same discipline as
 * `serverLogExcerpt`).
 *
 * The excerpt is bounded three ways so a single request can never carry an
 * unbounded (or unexpectedly sensitive) transcript:
 *   1. only the last {@link DEFAULT_TRANSCRIPT_MAX_MESSAGES} messages (~10 turns),
 *   2. each individual tool input/result trimmed to
 *      {@link MAX_TOOL_OUTPUT_CHARS} (a 1,200-line file read becomes a stub), and
 *   3. the whole excerpt hard-capped at `MAX_TRANSCRIPT_LEN`.
 *
 * **Scrubbing is mandatory before this ever leaves the process.** Transcripts
 * are the most sensitive surface (people paste code, env output, occasionally
 * secrets), so every excerpt runs through the same `redactPaths`/`redactTokens`
 * pair the crash-report and log-excerpt pipelines use (`@dorkos/shared/
 * error-report`) before this module returns anything.
 *
 * @module lib/transcript-excerpt
 */
import { redactPaths, redactTokens } from '@dorkos/shared/error-report';
import { MAX_TRANSCRIPT_LEN } from '@dorkos/shared/telemetry-events';
import type { HistoryMessage } from '@dorkos/shared/types';

import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { DEFAULT_CWD } from './resolve-root.js';

/** Default number of trailing messages an excerpt keeps (~10 user/assistant turns). */
export const DEFAULT_TRANSCRIPT_MAX_MESSAGES = 20;

/** Maximum characters kept from a single tool input or result before it is stubbed. */
export const MAX_TOOL_OUTPUT_CHARS = 500;

/** Trim one long tool input/result to {@link MAX_TOOL_OUTPUT_CHARS}, marking the cut. */
function trimToolOutput(value: string): string {
  const collapsed = value.trim();
  return collapsed.length > MAX_TOOL_OUTPUT_CHARS
    ? `${collapsed.slice(0, MAX_TOOL_OUTPUT_CHARS)}… [trimmed]`
    : collapsed;
}

/**
 * Format one message (its text, tool calls, and any failure) into readable
 * lines for the excerpt.
 *
 * The failure is read from `parts`, because that is the only place it lives: a
 * turn that failed before the model said anything has EMPTY `content` and no
 * tool calls, so text-and-tools alone rendered it as a bare `assistant:` line.
 * That is precisely the turn a person attaches a transcript to report, and the
 * report arrived describing nothing (DOR-1666). Tool calls keep coming from
 * `toolCalls` rather than `parts`, so a message carrying both is not printed
 * twice.
 */
function formatMessage(message: HistoryMessage): string {
  const lines: string[] = [`${message.role}: ${message.content.trim()}`.trim()];
  for (const tool of message.toolCalls ?? []) {
    lines.push(`  [tool: ${tool.toolName}]`);
    if (tool.input) lines.push(`    input: ${trimToolOutput(tool.input)}`);
    if (tool.result) lines.push(`    result: ${trimToolOutput(tool.result)}`);
  }
  for (const part of message.parts ?? []) {
    if (part.type !== 'error') continue;
    const label = part.category === undefined ? 'error' : `error: ${part.category}`;
    lines.push(`  [${label}] ${trimToolOutput(part.message)}`);
  }
  return lines.join('\n');
}

/**
 * Build a bounded, scrubbed transcript excerpt from a session's message history.
 * Pure: takes the already-loaded messages and returns the excerpt string (or
 * `undefined` when there is nothing to attach), so its bounding/scrubbing is
 * unit-testable without a runtime.
 *
 * @param messages - The session's message history, oldest first.
 * @param maxMessages - How many trailing messages to keep. Defaults to
 *   {@link DEFAULT_TRANSCRIPT_MAX_MESSAGES}.
 * @returns The scrubbed, bounded excerpt (never containing a home directory,
 *   absolute path, or secret-shaped token), or `undefined` when the history is
 *   empty.
 */
export function buildTranscriptExcerpt(
  messages: HistoryMessage[],
  maxMessages: number = DEFAULT_TRANSCRIPT_MAX_MESSAGES
): string | undefined {
  if (messages.length === 0) return undefined;

  const recent = messages.slice(-maxMessages);
  const joined = recent.map(formatMessage).join('\n\n');
  const scrubbed = redactTokens(redactPaths(joined));
  if (!scrubbed.trim()) return undefined;

  // Reserve one character for the ellipsis so a truncated excerpt never exceeds
  // MAX_TRANSCRIPT_LEN by one (the schema bound this feeds).
  return scrubbed.length > MAX_TRANSCRIPT_LEN
    ? `${scrubbed.slice(0, MAX_TRANSCRIPT_LEN - 1)}…`
    : scrubbed;
}

/**
 * Gather a bounded, scrubbed excerpt of a session's recent conversation, for
 * attaching to a bug report. Resolves the session's runtime and working
 * directory server-side (never trusting a client-supplied path), reads its
 * message history, and hands it to {@link buildTranscriptExcerpt}.
 *
 * Never throws: an unregistered runtime, an unbound session, or an unreadable
 * transcript all resolve to `undefined` rather than blocking a feedback
 * submission — the excerpt is best-effort, exactly like the server log excerpt.
 *
 * @param sessionId - The session the transcript excerpt should come from.
 * @param maxMessages - How many trailing messages to keep. Defaults to
 *   {@link DEFAULT_TRANSCRIPT_MAX_MESSAGES}.
 * @returns The scrubbed, bounded excerpt, or `undefined` when none could be gathered.
 */
export async function getSessionTranscriptExcerpt(
  sessionId: string,
  maxMessages: number = DEFAULT_TRANSCRIPT_MAX_MESSAGES
): Promise<string | undefined> {
  try {
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // The session's own project directory is where its transcript lives; fall
    // back to the default working directory for a session with no bound agent
    // path (a best-effort read, not a guarantee).
    const cwd = (await runtimeRegistry.getSessionAgentPath(sessionId)) ?? DEFAULT_CWD;
    const internalId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    const messages = await runtime.getMessageHistory(cwd, internalId);
    return buildTranscriptExcerpt(messages, maxMessages);
  } catch {
    return undefined;
  }
}
