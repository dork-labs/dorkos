import { describe, it, expect } from 'vitest';
import { reconstructPreImage } from '../reconstruct.js';

describe('reconstructPreImage', () => {
  it('reverses a single Edit (new_string → old_string)', () => {
    const current = 'line1\nconst a = 2;\nline3\n';
    const pre = reconstructPreImage(
      'Edit',
      { old_string: 'const a = 1;', new_string: 'const a = 2;' },
      current
    );
    expect(pre).toBe('line1\nconst a = 1;\nline3\n');
  });

  it('reverses only the first occurrence unless replace_all', () => {
    const current = 'x\nx\n';
    expect(reconstructPreImage('Edit', { old_string: 'y', new_string: 'x' }, current)).toBe(
      'y\nx\n'
    );
    expect(
      reconstructPreImage('Edit', { old_string: 'y', new_string: 'x', replace_all: true }, current)
    ).toBe('y\ny\n');
  });

  it('reverses a MultiEdit in opposite order', () => {
    // Edits applied in order a→A then b→B; current has both applied.
    const current = 'A\nB\n';
    const pre = reconstructPreImage(
      'MultiEdit',
      {
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' },
        ],
      },
      current
    );
    expect(pre).toBe('a\nb\n');
  });

  it('returns null when a replacement target is no longer present', () => {
    const pre = reconstructPreImage(
      'Edit',
      { old_string: 'const a = 1;', new_string: 'MISSING' },
      'unrelated content\n'
    );
    expect(pre).toBeNull();
  });

  it('returns null for a Write (no recoverable pre-image)', () => {
    expect(reconstructPreImage('Write', { content: 'whatever' }, 'whatever')).toBeNull();
  });

  it('returns null for a NotebookEdit (not a plain-text reversal)', () => {
    expect(reconstructPreImage('NotebookEdit', { cell: 'x' }, 'x')).toBeNull();
  });
});
