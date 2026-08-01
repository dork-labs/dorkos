/**
 * What survives the parts → `toolCalls` derivation.
 *
 * The input-zone approval card is driven by a `ToolCallState`, not by the part
 * it came from, so anything this derivation drops is invisible on the card a
 * person actually answers — however complete the projected part was.
 */
import { describe, it, expect } from 'vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { deriveFromParts } from '../stream-event-helpers';

describe('deriveFromParts', () => {
  it('keeps everything the approval card needs to render its ask', () => {
    // Purpose: the pending card in the input zone renders the SDK's context —
    // what is being asked for, which path triggered it, why it was gated — and
    // counts down against the server's deadline. Dropping these here left the
    // card with a bare tool name and no countdown, no matter what the stream
    // had said (DOR-810).
    const parts: MessagePart[] = [
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        input: '{"command":"rm -rf node_modules"}',
        status: 'pending',
        interactiveType: 'approval',
        timeoutMs: 600_000,
        approvalStartedAt: 1_000,
        approvalRemainingMs: 540_000,
        approvalTitle: 'Run a shell command?',
        approvalDisplayName: 'rm -rf node_modules',
        approvalDescription: 'This deletes a directory.',
        approvalBlockedPath: '/repo/node_modules',
        approvalDecisionReason: 'Command not in the allow list',
        approvalHasSuggestions: true,
      },
    ];

    expect(deriveFromParts(parts).toolCalls[0]).toMatchObject({
      timeoutMs: 600_000,
      approvalStartedAt: 1_000,
      approvalRemainingMs: 540_000,
      approvalTitle: 'Run a shell command?',
      approvalDisplayName: 'rm -rf node_modules',
      approvalDescription: 'This deletes a directory.',
      approvalBlockedPath: '/repo/node_modules',
      approvalDecisionReason: 'Command not in the allow list',
      approvalHasSuggestions: true,
    });
  });

  it('joins text parts and leaves an ordinary tool call untouched', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'tool_call', toolCallId: 'tc-2', toolName: 'Read', input: '{}', status: 'complete' },
    ];
    const derived = deriveFromParts(parts);
    expect(derived.content).toBe('one\ntwo');
    expect(derived.toolCalls).toHaveLength(1);
    expect(derived.toolCalls[0]).toMatchObject({ toolCallId: 'tc-2', status: 'complete' });
  });
});
