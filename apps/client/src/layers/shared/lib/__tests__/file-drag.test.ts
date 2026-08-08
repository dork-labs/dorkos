import { describe, it, expect, vi } from 'vitest';
import { FILE_PATH_DRAG_TYPE, hasFilePathDrag, readFilePathDrag } from '../file-drag';

/** A `DataTransfer` stand-in — jsdom implements none. */
function dataTransfer(entries: Record<string, string>): DataTransfer {
  const map = new Map(Object.entries(entries));
  return {
    types: [...map.keys()],
    getData: vi.fn((type: string) => map.get(type) ?? ''),
  } as unknown as DataTransfer;
}

describe('file-drag', () => {
  it('recognises the type whatever case the browser reports it in', () => {
    // Browsers lowercase custom drag types; a mixed-case reading must still
    // match, or the whole feature silently stops working in one of them.
    expect(hasFilePathDrag([FILE_PATH_DRAG_TYPE])).toBe(true);
    expect(hasFilePathDrag(['Application/X-DorkOS-File-Path'])).toBe(true);
  });

  it('does not mistake an operating-system file drop for one of ours', () => {
    expect(hasFilePathDrag(['Files', 'text/plain'])).toBe(false);
    expect(readFilePathDrag(dataTransfer({ Files: '', 'text/plain': 'notes.md' }))).toBeNull();
  });

  it('reads the dragged path out of the payload', () => {
    expect(
      readFilePathDrag(
        dataTransfer({ 'text/plain': 'src/a.ts', [FILE_PATH_DRAG_TYPE]: 'src/a.ts' })
      )
    ).toBe('src/a.ts');
  });

  it('treats a present-but-empty payload as no path', () => {
    expect(readFilePathDrag(dataTransfer({ [FILE_PATH_DRAG_TYPE]: '' }))).toBeNull();
  });
});
