import { describe, it, expect } from 'vitest';
import { pendingInteractionToStreamEvent } from '../pending-interaction-events.js';
import { SESSIONS } from '../../config/constants.js';

describe('pendingInteractionToStreamEvent', () => {
  it('maps an approval DTO to approval_required with id on toolCallId', () => {
    // Purpose: approvals re-emit under their native event name with dto.id on
    // the toolCallId routing field and a server-authoritative remainingMs.
    const event = pendingInteractionToStreamEvent({
      type: 'approval',
      id: 'tc-1',
      startedAt: 1_700_000_000_000,
      remainingMs: 540_000,
      toolName: 'Bash',
      input: JSON.stringify({ command: 'ls' }),
      hasSuggestions: true,
      title: 'Run Bash',
    });

    expect(event.type).toBe('approval_required');
    expect(event.data).toEqual({
      toolCallId: 'tc-1',
      toolName: 'Bash',
      input: JSON.stringify({ command: 'ls' }),
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
      startedAt: 1_700_000_000_000,
      remainingMs: 540_000,
      hasSuggestions: true,
      title: 'Run Bash',
    });
  });

  it('omits absent optional approval fields rather than emitting undefined', () => {
    // Purpose: the spread-guard keeps the re-emitted payload identical in shape
    // to the original emit — no `title: undefined` keys leak through.
    const event = pendingInteractionToStreamEvent({
      type: 'approval',
      id: 'tc-2',
      startedAt: 0,
      remainingMs: 1,
      toolName: 'Read',
      input: '{}',
      hasSuggestions: false,
    });

    expect(Object.keys(event.data)).not.toContain('title');
    expect(Object.keys(event.data)).not.toContain('blockedPath');
  });

  it('maps a question DTO to question_prompt with id on toolCallId', () => {
    // Purpose: questions re-emit as question_prompt keyed by toolCallId.
    const event = pendingInteractionToStreamEvent({
      type: 'question',
      id: 'q-1',
      startedAt: 100,
      remainingMs: 200,
      questions: [{ header: 'Pick', question: 'Which?', multiSelect: false, options: [] }],
    });

    expect(event.type).toBe('question_prompt');
    expect(event.data).toMatchObject({ toolCallId: 'q-1', remainingMs: 200, startedAt: 100 });
  });

  it('maps an elicitation DTO to elicitation_prompt with id on interactionId', () => {
    // Purpose: elicitations re-emit as elicitation_prompt keyed by
    // interactionId (their routing field, distinct from approvals/questions).
    const event = pendingInteractionToStreamEvent({
      type: 'elicitation',
      id: 'el-1',
      startedAt: 5,
      remainingMs: 10,
      serverName: 'mcp',
      message: 'Key?',
    });

    expect(event.type).toBe('elicitation_prompt');
    expect(event.data).toMatchObject({
      interactionId: 'el-1',
      serverName: 'mcp',
      message: 'Key?',
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
      remainingMs: 10,
      startedAt: 5,
    });
  });
});
