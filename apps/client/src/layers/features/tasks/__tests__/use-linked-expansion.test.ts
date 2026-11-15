// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLinkedExpansion } from '../lib/use-linked-expansion';

describe('useLinkedExpansion (DOR-4121)', () => {
  it('opens the linked schedule on arrival', () => {
    const { result } = renderHook(() => useLinkedExpansion('b'));
    expect(result.current.expandedId).toBe('b');
  });

  it('opens nothing without a link', () => {
    const { result } = renderHook(() => useLinkedExpansion(undefined));
    expect(result.current.expandedId).toBeNull();
  });

  it('moves to a new link while the page is open, then follows clicks', () => {
    const { result, rerender } = renderHook(({ id }) => useLinkedExpansion(id), {
      initialProps: { id: 'b' as string | undefined },
    });
    rerender({ id: 'a' });
    expect(result.current.expandedId).toBe('a');
    act(() => result.current.toggle('a'));
    expect(result.current.expandedId).toBeNull();
    act(() => result.current.toggle('c'));
    expect(result.current.expandedId).toBe('c');
    // The same link again does not override the person's choice.
    rerender({ id: 'a' });
    expect(result.current.expandedId).toBe('c');
  });
});
