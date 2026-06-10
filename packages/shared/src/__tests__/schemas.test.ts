import { describe, it, expect } from 'vitest';
import {
  ApprovalEventSchema,
  MemoryRecallPartSchema,
  MessagePartSchema,
  PendingInteractionDTOSchema,
} from '../schemas.js';

describe('MemoryRecallPartSchema', () => {
  it('accepts a valid select-mode part', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/.claude/CLAUDE.md', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid synthesize-mode part with content', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'synthesize',
      memories: [{ path: '<synthesis:~/.claude>', scope: 'team', content: 'A summary…' }],
      isStreaming: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a part with an unknown mode', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'invalid',
      memories: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a memory row with an unknown scope', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'org' }],
    });
    expect(result.success).toBe(false);
  });

  it('treats content as optional on select rows', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });

  it('treats isStreaming as optional', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty memories array at the schema level (defense-in-depth tolerates it)', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [],
    });
    expect(result.success).toBe(true);
  });

  it('integrates into MessagePartSchema discriminated union', () => {
    const result = MessagePartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('PendingInteractionDTOSchema', () => {
  it('accepts an approval interaction', () => {
    // Purpose: approval DTO valid.
    expect(() =>
      PendingInteractionDTOSchema.parse({
        type: 'approval',
        id: 'x',
        startedAt: 1,
        remainingMs: 2,
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: false,
      })
    ).not.toThrow();
  });

  it('accepts a question interaction', () => {
    // Purpose: all three branches valid (question branch).
    const result = PendingInteractionDTOSchema.safeParse({
      type: 'question',
      id: 'q1',
      startedAt: 10,
      remainingMs: 5000,
      questions: [
        {
          header: 'Pick one',
          question: 'Which option?',
          options: [{ label: 'A' }],
          multiSelect: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an elicitation interaction', () => {
    // Purpose: all three branches valid (elicitation branch).
    const result = PendingInteractionDTOSchema.safeParse({
      type: 'elicitation',
      id: 'e1',
      startedAt: 20,
      remainingMs: 8000,
      serverName: 'github',
      message: 'Authorize access',
      mode: 'url',
      url: 'https://example.com/auth',
      elicitationId: 'elic-1',
      requestedSchema: { kind: 'object' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an interaction with an unknown type', () => {
    // Purpose: discriminated union rejects out-of-set types.
    const result = PendingInteractionDTOSchema.safeParse({
      type: 'unknown',
      id: 'z',
      startedAt: 1,
      remainingMs: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('ApprovalEventSchema remainingMs', () => {
  const base = {
    toolCallId: 'tc1',
    toolName: 'Bash',
    input: '{}',
    timeoutMs: 30000,
    startedAt: 1,
    hasSuggestions: false,
  };

  it('parses with remainingMs present', () => {
    // Purpose: additive/optional, back-compatible (recovery re-emit case).
    const result = ApprovalEventSchema.safeParse({ ...base, remainingMs: 1234 });
    expect(result.success).toBe(true);
  });

  it('parses without remainingMs', () => {
    // Purpose: additive/optional, back-compatible (originating in-band emit case).
    const result = ApprovalEventSchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});
