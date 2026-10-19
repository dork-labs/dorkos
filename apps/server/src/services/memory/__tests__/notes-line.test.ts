/**
 * The line that tells an agent its notes files exist.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryNoteList } from '@dorkos/shared/memory-provider';

import { renderMemoryNotesLine } from '../notes-line.js';

function list(total: number, names: string[], recentlyMigrated = 0): MemoryNoteList {
  return {
    status: 'ok',
    total,
    recentlyMigrated,
    notes: names.map((name) => ({
      name,
      description: 'd',
      bytes: 1,
      updatedAt: '2026-10-17T00:00:00.000Z',
    })),
  };
}

describe('renderMemoryNotesLine', () => {
  it('renders nothing with no notes, or when the list failed', () => {
    expect(renderMemoryNotesLine(list(0, []))).toBe('');
    expect(
      renderMemoryNotesLine({
        status: 'error',
        total: 0,
        recentlyMigrated: 0,
        notes: [],
        error: 'x',
      })
    ).toBe('');
  });

  it('names the latest notes inside a fence, and only DorkOS words outside it', () => {
    const text = renderMemoryNotesLine(list(23, ['tokens', 'genome', 'ops']), 'N0NCE');
    const [outside, ...fenced] = text.split('\n');
    expect(outside).toContain('You also keep 23 notes');
    expect(outside).toContain('`memory_read`');
    expect(outside).not.toContain('tokens');
    expect(fenced.join('\n')).toContain('Latest: tokens, genome, ops, …');
    expect(fenced[0]).toBe('--- BEGIN AGENT NOTES N0NCE ---');
    expect(fenced.at(-1)).toBe('--- END AGENT NOTES N0NCE ---');
  });

  it('nudges to tidy above 150, leaving this week’s migrated notes out of the count', () => {
    expect(renderMemoryNotesLine(list(151, ['a']))).toContain('time to tidy');
    expect(renderMemoryNotesLine(list(348, ['a'], 300))).not.toContain('time to tidy');
    expect(renderMemoryNotesLine(list(150, ['a']))).not.toContain('time to tidy');
  });
});
