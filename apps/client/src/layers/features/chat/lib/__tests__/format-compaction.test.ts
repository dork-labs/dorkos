import { describe, it, expect } from 'vitest';
import { formatTokenCount, formatCompactionLabel } from '../format-compaction';

describe('formatTokenCount', () => {
  it('abbreviates thousands to one decimal', () => {
    expect(formatTokenCount(50115)).toBe('50.1k');
    expect(formatTokenCount(1000)).toBe('1.0k');
  });

  it('leaves sub-thousand counts as plain integers', () => {
    expect(formatTokenCount(840)).toBe('840');
    expect(formatTokenCount(0)).toBe('0');
  });
});

describe('formatCompactionLabel', () => {
  it('builds a label with token count and trigger', () => {
    expect(formatCompactionLabel({ trigger: 'manual', preTokens: 50115 })).toBe(
      'Context compacted · 50.1k tokens · manual'
    );
  });

  it('omits the token segment when preTokens is absent', () => {
    expect(formatCompactionLabel({ trigger: 'auto' })).toBe('Context compacted · auto');
  });

  it('includes a zero token count (0 survives, not dropped)', () => {
    expect(formatCompactionLabel({ preTokens: 0 })).toBe('Context compacted · 0 tokens');
  });

  it('degrades to a bare label when no metadata was recorded', () => {
    expect(formatCompactionLabel()).toBe('Context compacted');
    expect(formatCompactionLabel({})).toBe('Context compacted');
  });
});
