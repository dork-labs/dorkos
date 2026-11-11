/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setExtensionNames } from '@/layers/shared/lib/extension-names';
import { useAppOpeners } from '../model/use-app-openers';

afterEach(() => setExtensionNames({}));

describe('who opened a canvas document, in DorkOS’s words (DOR-3293)', () => {
  it('names the app from DorkOS’s own records', () => {
    setExtensionNames({ desk: 'Desk' });
    const { result } = renderHook(() => useAppOpeners());
    expect(result.current('desk')).toEqual({ name: 'Desk', icon: undefined });
  });

  it('names nobody for an app DorkOS does not know, or no mark at all', () => {
    setExtensionNames({ desk: 'Desk' });
    const { result } = renderHook(() => useAppOpeners());
    expect(result.current('gone')).toBeNull();
    expect(result.current(undefined)).toBeNull();
  });

  it('follows a new listing', () => {
    const { result } = renderHook(() => useAppOpeners());
    expect(result.current('desk')).toBeNull();
    act(() => setExtensionNames({ desk: 'Desk 2' }));
    expect(result.current('desk')?.name).toBe('Desk 2');
  });
});
