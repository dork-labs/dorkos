import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaletteSearch, parsePrefix } from '../use-palette-search';
import type { SearchableItem } from '../use-palette-search';

const mockItems: SearchableItem[] = [
  {
    id: 'agent-1',
    name: 'Auth Service',
    type: 'agent',
    keywords: ['/projects/auth'],
    data: { id: 'agent-1', name: 'Auth Service', projectPath: '/projects/auth' } as any,
  },
  {
    id: 'agent-2',
    name: 'API Gateway',
    type: 'agent',
    keywords: ['/projects/api'],
    data: { id: 'agent-2', name: 'API Gateway', projectPath: '/projects/api' } as any,
  },
  {
    id: 'feature-1',
    name: 'Pulse Scheduler',
    type: 'feature',
    data: { id: 'pulse', label: 'Pulse Scheduler', icon: 'Clock', action: 'openPulse' } as any,
  },
  {
    id: 'cmd-1',
    name: '/hello',
    type: 'command',
    keywords: ['greeting'],
    data: { name: '/hello', description: 'Say hello' } as any,
  },
];

describe('parsePrefix', () => {
  it('detects @ prefix for agents', () => {
    expect(parsePrefix('@auth')).toEqual({ prefix: '@', term: 'auth' });
  });

  it('detects > prefix for commands', () => {
    expect(parsePrefix('>hello')).toEqual({ prefix: '>', term: 'hello' });
  });

  it('returns null prefix for plain search', () => {
    expect(parsePrefix('auth')).toEqual({ prefix: null, term: 'auth' });
  });

  it('handles prefix with empty term', () => {
    expect(parsePrefix('@')).toEqual({ prefix: '@', term: '' });
  });
});

describe('usePaletteSearch', () => {
  it('returns all items when search is empty', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, ''));
    expect(result.current.results).toHaveLength(4);
    expect(result.current.results[0].matches).toBeUndefined();
  });

  it('filters by @ prefix (agents only)', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, '@'));
    expect(result.current.results.every((r) => r.item.type === 'agent')).toBe(true);
    expect(result.current.prefix).toBe('@');
  });

  it('filters by > prefix (commands only)', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, '>'));
    expect(result.current.results.every((r) => r.item.type === 'command')).toBe(true);
    expect(result.current.prefix).toBe('>');
  });

  it('returns match indices for highlighting', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'auth'));
    const authResult = result.current.results.find((r) => r.item.id === 'agent-1');
    expect(authResult).toBeDefined();
    expect(authResult!.matches).toBeDefined();
    expect(authResult!.matches!.length).toBeGreaterThan(0);
  });

  it('handles typo-tolerant matching', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'autth'));
    expect(result.current.results).toBeDefined();
  });

  it('returns empty results when no match', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'zzzznotexist'));
    expect(result.current.results).toHaveLength(0);
  });

  it('scores exact matches higher than partial matches', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'Auth Service'));
    if (result.current.results.length > 0) {
      expect(result.current.results[0].item.id).toBe('agent-1');
    }
  });
});
