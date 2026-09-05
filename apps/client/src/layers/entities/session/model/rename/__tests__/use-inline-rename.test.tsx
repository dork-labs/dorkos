/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useInlineRename } from '../use-inline-rename';

beforeEach(() => {
  // The hook focuses on the next frame, to beat Radix's focus restoration.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => vi.unstubAllGlobals());

describe('useInlineRename', () => {
  it('opens closed, and opens with the current name', () => {
    const { result } = renderHook(() =>
      useInlineRename({ value: 'Fix the parser', onCommit: vi.fn() })
    );
    expect(result.current.isRenaming).toBe(false);

    act(() => result.current.start());
    expect(result.current.isRenaming).toBe(true);
    expect(result.current.renameValue).toBe('Fix the parser');
  });

  it('commits the trimmed name and closes', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useInlineRename({ value: 'Old', onCommit }));

    act(() => result.current.start());
    act(() => result.current.setRenameValue('  New name  '));
    act(() => result.current.commit());

    expect(onCommit).toHaveBeenCalledWith('New name');
    expect(result.current.isRenaming).toBe(false);
  });

  it('says nothing when the name did not change', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useInlineRename({ value: 'Same', onCommit }));

    act(() => result.current.start());
    act(() => result.current.commit());

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('says nothing when the field was emptied', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useInlineRename({ value: 'Old', onCommit }));

    act(() => result.current.start());
    act(() => result.current.setRenameValue('   '));
    act(() => result.current.commit());

    expect(onCommit).not.toHaveBeenCalled();
  });

  // The guard the three rows each carried: pressing Enter blurs the input, and
  // the blur handler is the same `commit`. Without it the rename fires twice.
  it('ignores the blur that follows a commit', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useInlineRename({ value: 'Old', onCommit }));

    act(() => result.current.start());
    act(() => result.current.setRenameValue('New'));
    act(() => result.current.commit());
    act(() => result.current.commit());

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('drops the draft on cancel, and stays dropped when the blur lands', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useInlineRename({ value: 'Old', onCommit }));

    act(() => result.current.start());
    act(() => result.current.setRenameValue('New'));
    act(() => result.current.cancel());
    act(() => result.current.commit());

    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.isRenaming).toBe(false);
  });

  it('maps Enter to commit and Escape to cancel', () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useInlineRename({ value: 'Old', onCommit }));

    act(() => result.current.start());
    act(() => result.current.setRenameValue('Enter wins'));
    act(() =>
      result.current.handleKeyDown({
        key: 'Enter',
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLInputElement>)
    );
    expect(onCommit).toHaveBeenCalledWith('Enter wins');

    onCommit.mockClear();
    act(() => result.current.start());
    act(() => result.current.setRenameValue('Escape loses'));
    act(() =>
      result.current.handleKeyDown({
        key: 'Escape',
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLInputElement>)
    );
    expect(onCommit).not.toHaveBeenCalled();
  });

  // The sidebar row's one real variation: it puts focus back on the row the
  // input replaced, so a keyboard reader is not dropped onto `<body>`.
  it('runs onEnd however the editor closed', () => {
    const onEnd = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({ value: 'Old', onCommit: vi.fn(), onEnd })
    );

    act(() => result.current.start());
    act(() => result.current.commit());
    expect(onEnd).toHaveBeenCalledTimes(1);

    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(onEnd).toHaveBeenCalledTimes(2);
  });
});
