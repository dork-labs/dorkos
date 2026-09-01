/**
 * Tests for the transcript-excerpt builder (feedback-pipeline spec Parts 5-6).
 *
 * Focused on {@link buildTranscriptExcerpt}, the pure half — its bounding
 * (message count + tool-output trimming + hard cap) and its MANDATORY scrubbing.
 * The scrubbing test is the load-bearing one: a transcript is the most sensitive
 * surface, so an excerpt that ever leaves the process with a home path or a
 * secret-shaped token is a real defect. The gathering wrapper
 * ({@link getSessionTranscriptExcerpt}) is thin over the runtime registry and is
 * exercised through the feedback route test.
 */
import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import { MAX_TRANSCRIPT_LEN } from '@dorkos/shared/telemetry-events';
import {
  buildTranscriptExcerpt,
  DEFAULT_TRANSCRIPT_MAX_MESSAGES,
  MAX_TOOL_OUTPUT_CHARS,
} from '../transcript-excerpt.js';

/** Build a minimal message with the fields the excerpt reads. */
function msg(
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: HistoryMessage['toolCalls']
): HistoryMessage {
  return {
    id: `${role}-${content.slice(0, 8)}`,
    role,
    content,
    ...(toolCalls ? { toolCalls } : {}),
  };
}

describe('buildTranscriptExcerpt', () => {
  it('returns undefined for an empty history', () => {
    expect(buildTranscriptExcerpt([])).toBeUndefined();
  });

  it('formats role-prefixed lines for user and assistant messages', () => {
    const out = buildTranscriptExcerpt([
      msg('user', 'why did it crash?'),
      msg('assistant', 'let me look'),
    ]);
    expect(out).toContain('user: why did it crash?');
    expect(out).toContain('assistant: let me look');
  });

  // A failed turn is exactly what someone attaches a transcript to report, and
  // its whole content lives in an error PART — the message text is empty. Read
  // from `content` and `toolCalls` alone, that turn rendered as a bare
  // "assistant:" line and the bug report arrived describing nothing (DOR-1666).
  it('renders an error-only turn as its failure, not a blank assistant line', () => {
    const out =
      buildTranscriptExcerpt([
        msg('user', 'run the tests'),
        {
          id: 'assistant-failed',
          role: 'assistant',
          content: '',
          parts: [{ type: 'error', message: 'OAuth token revoked', category: 'auth_error' }],
        },
      ]) ?? '';

    expect(out).toContain('[error: auth_error] OAuth token revoked');
    // The turn is no longer an empty line with a role on it.
    expect(out).not.toMatch(/assistant:\s*$/);
  });

  it('renders an error that rides alongside text and tools', () => {
    const out =
      buildTranscriptExcerpt([
        {
          id: 'assistant-partial',
          role: 'assistant',
          content: 'Starting now.',
          toolCalls: [{ toolCallId: 'c1', toolName: 'bash', status: 'complete', result: 'ok' }],
          parts: [
            { type: 'text', text: 'Starting now.' },
            { type: 'error', message: 'upstream 500' },
          ],
        },
      ]) ?? '';

    expect(out).toContain('assistant: Starting now.');
    expect(out).toContain('[tool: bash]');
    // No category means no category label — nothing is invented.
    expect(out).toContain('[error] upstream 500');
  });

  it('trims an oversized error message like any other attached output', () => {
    const out =
      buildTranscriptExcerpt([
        {
          id: 'assistant-long',
          role: 'assistant',
          content: '',
          parts: [{ type: 'error', message: 'E'.repeat(MAX_TOOL_OUTPUT_CHARS + 200) }],
        },
      ]) ?? '';

    expect(out).toContain('… [trimmed]');
    expect(out).not.toContain('E'.repeat(MAX_TOOL_OUTPUT_CHARS + 1));
  });

  it('keeps only the last N messages (turn-bounded, newest kept)', () => {
    const messages = Array.from({ length: DEFAULT_TRANSCRIPT_MAX_MESSAGES + 6 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `line ${i}`)
    );
    const out = buildTranscriptExcerpt(messages) ?? '';
    // The earliest messages are dropped; the final one is kept.
    expect(out).not.toContain('line 0');
    expect(out).not.toContain('line 5');
    expect(out).toContain(`line ${messages.length - 1}`);
  });

  it('trims an oversized tool output to a stub', () => {
    const huge = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 500);
    const out =
      buildTranscriptExcerpt([
        msg('assistant', 'reading a big file', [
          { toolCallId: 't1', toolName: 'Read', result: huge, status: 'complete' },
        ]),
      ]) ?? '';
    expect(out).toContain('[tool: Read]');
    expect(out).toContain('… [trimmed]');
    expect(out).not.toContain('x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1));
  });

  it('hard-caps the whole excerpt at MAX_TRANSCRIPT_LEN', () => {
    const messages = Array.from({ length: DEFAULT_TRANSCRIPT_MAX_MESSAGES }, () =>
      msg('assistant', 'y'.repeat(MAX_TRANSCRIPT_LEN))
    );
    const out = buildTranscriptExcerpt(messages) ?? '';
    expect(out.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_LEN);
    expect(out.endsWith('…')).toBe(true);
  });

  // The load-bearing guarantee: scrubbing runs before the excerpt is returned.
  // Reverting the `redactTokens(redactPaths(...))` call in the builder turns
  // this red — the raw home path and token would survive.
  it('scrubs home paths and secret-shaped tokens out of message content', () => {
    const out =
      buildTranscriptExcerpt([
        msg('user', 'it failed at /Users/dorian/project/src/index.ts'),
        msg('assistant', 'your key sk-abcdef0123456789 looks wrong'),
      ]) ?? '';
    expect(out).not.toContain('/Users/dorian');
    expect(out).toContain('~');
    expect(out).not.toContain('sk-abcdef0123456789');
    expect(out).toContain('[redacted]');
  });

  it('scrubs secrets that ride in tool inputs and results too', () => {
    const out =
      buildTranscriptExcerpt([
        msg('assistant', 'running a command', [
          {
            toolCallId: 't1',
            toolName: 'Bash',
            input: 'export TOKEN=ghp_0123456789abcdef0123',
            result: 'wrote /home/dorian/.env',
            status: 'complete',
          },
        ]),
      ]) ?? '';
    expect(out).not.toContain('ghp_0123456789abcdef0123');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('/home/dorian');
  });
});
