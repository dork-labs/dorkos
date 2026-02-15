import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// Mock platform
let mockIsEmbedded = false;
vi.mock('@/layers/shared/lib/platform', () => ({
  getPlatform: () => ({ isEmbedded: mockIsEmbedded }),
}));

// Mock app store
let mockStoreDir: string | null = null;
const mockSetStoreDir = vi.fn((dir: string | null) => {
  mockStoreDir = dir;
});
vi.mock('@/layers/shared/lib/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      selectedCwd: mockStoreDir,
      setSelectedCwd: mockSetStoreDir,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock useSessionId
const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [null, mockSetSessionId] as const,
}));

// Mock nuqs useQueryState
let mockUrlDir: string | null = null;
const mockSetUrlDir = vi.fn((dir: string | null) => {
  mockUrlDir = dir;
});
vi.mock('nuqs', () => ({
  useQueryState: () => [mockUrlDir, mockSetUrlDir],
}));

import { useDirectoryState } from '../model/use-directory-state';

describe('useDirectoryState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEmbedded = false;
    mockStoreDir = null;
    mockUrlDir = null;
  });

  it('returns URL state in standalone mode', () => {
    mockUrlDir = '/test/path';
    const { result } = renderHook(() => useDirectoryState());
    expect(result.current[0]).toBe('/test/path');
  });

  it('returns Zustand state in embedded mode', () => {
    mockIsEmbedded = true;
    mockStoreDir = '/embedded/path';
    const { result } = renderHook(() => useDirectoryState());
    expect(result.current[0]).toBe('/embedded/path');
  });

  it('setter updates both URL and Zustand in standalone', () => {
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1]('/new/path');
    });
    expect(mockSetUrlDir).toHaveBeenCalledWith('/new/path');
    expect(mockSetStoreDir).toHaveBeenCalledWith('/new/path');
  });

  it('setter clears session ID on directory change', () => {
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1]('/any/path');
    });
    expect(mockSetSessionId).toHaveBeenCalledWith(null);
  });

  it('setting null removes ?dir= from URL', () => {
    mockUrlDir = '/existing/path';
    const { result } = renderHook(() => useDirectoryState());
    act(() => {
      result.current[1](null);
    });
    expect(mockSetUrlDir).toHaveBeenCalledWith(null);
  });

  it('falls back to Zustand when URL has no ?dir= param', () => {
    mockUrlDir = null;
    mockStoreDir = '/default/path';
    const { result } = renderHook(() => useDirectoryState());
    expect(result.current[0]).toBe('/default/path');
  });
});
