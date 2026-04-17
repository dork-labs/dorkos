import { describe, it, expect } from 'vitest';
import { MemoryRecallPartSchema, MessagePartSchema } from '../schemas.js';

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
