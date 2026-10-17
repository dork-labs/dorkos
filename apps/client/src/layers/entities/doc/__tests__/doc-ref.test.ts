import { describe, expect, it } from 'vitest';
import { docRefFor } from '../lib/doc-ref';

describe('docRefFor', () => {
  it('names a relative markdown file as it is', () => {
    expect(docRefFor('/work', 'notes/plan.md')).toEqual({ cwd: '/work', path: 'notes/plan.md' });
  });

  it('makes an absolute path inside the folder relative', () => {
    expect(docRefFor('/work/', '/work/notes/plan.md')).toEqual({
      cwd: '/work/',
      path: 'notes/plan.md',
    });
    expect(docRefFor('C:\\work', 'C:\\work\\plan.md')).toEqual({
      cwd: 'C:\\work',
      path: 'plan.md',
    });
  });

  it('names no doc outside the folder, without a folder, or for a file that is not markdown', () => {
    expect(docRefFor('/work', '/elsewhere/plan.md')).toBeNull();
    expect(docRefFor('/work', '/workshop/plan.md')).toBeNull();
    expect(docRefFor(null, 'plan.md')).toBeNull();
    expect(docRefFor('/work', 'script.ts')).toBeNull();
    expect(docRefFor('/work', 'notes.markdown')).toBeNull();
  });
});
