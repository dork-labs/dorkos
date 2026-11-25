/**
 * The `<context_warning>` note each runtime renders (DOR-2732).
 */
import { describe, it, expect } from 'vitest';
import { formatContextWarning } from '../context-warning-block.js';

describe('formatContextWarning', () => {
  it.each([
    ['claude-code', 'mcp__dorkos__compact_my_session', 'mcp__dorkos__memory_write'],
    ['codex', 'mcp__dorkos__compact_my_session', 'mcp__dorkos__memory_write'],
    ['opencode', 'dorkos_compact_my_session', 'dorkos_memory_write'],
  ] as const)('names tools %s can call', (runtime, compact, memory) => {
    const text = formatContextWarning({ percent: 81, canCompact: true }, runtime);
    expect(text).toContain('81%');
    expect(text).toContain(compact);
    expect(text).toContain(memory);
  });

  it('never names the summary tool where it would only refuse', () => {
    const text = formatContextWarning({ percent: 85, canCompact: false }, 'codex');
    expect(text).toContain('85%');
    expect(text).not.toContain('compact_my_session');
    expect(text).toContain('mcp__dorkos__memory_write');
  });
});
