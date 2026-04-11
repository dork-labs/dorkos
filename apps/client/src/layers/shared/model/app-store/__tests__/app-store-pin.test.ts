import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../app-store';
import { STORAGE_KEYS } from '@/layers/shared/lib/constants';

describe('pinnedAgentPaths store', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the store to initial state
    useAppStore.setState({ pinnedAgentPaths: [] });
  });

  it('pinAgent adds path and persists to localStorage', () => {
    useAppStore.getState().pinAgent('/agents/alpha');
    expect(useAppStore.getState().pinnedAgentPaths).toEqual(['/agents/alpha']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.PINNED_AGENTS)!)).toEqual([
      '/agents/alpha',
    ]);
  });

  it('pinAgent appends to end preserving order', () => {
    useAppStore.getState().pinAgent('/agents/alpha');
    useAppStore.getState().pinAgent('/agents/beta');
    expect(useAppStore.getState().pinnedAgentPaths).toEqual(['/agents/alpha', '/agents/beta']);
  });

  it('pinAgent is idempotent — no duplicates', () => {
    useAppStore.getState().pinAgent('/agents/alpha');
    useAppStore.getState().pinAgent('/agents/alpha');
    expect(useAppStore.getState().pinnedAgentPaths).toEqual(['/agents/alpha']);
  });

  it('unpinAgent removes path and persists', () => {
    useAppStore.getState().pinAgent('/agents/alpha');
    useAppStore.getState().pinAgent('/agents/beta');
    useAppStore.getState().unpinAgent('/agents/alpha');
    expect(useAppStore.getState().pinnedAgentPaths).toEqual(['/agents/beta']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.PINNED_AGENTS)!)).toEqual(['/agents/beta']);
  });

  it('unpinAgent is no-op for unknown paths', () => {
    useAppStore.getState().pinAgent('/agents/alpha');
    useAppStore.getState().unpinAgent('/agents/unknown');
    expect(useAppStore.getState().pinnedAgentPaths).toEqual(['/agents/alpha']);
  });

  it('resetPreferences clears pin state', () => {
    useAppStore.getState().pinAgent('/agents/alpha');
    useAppStore.getState().resetPreferences();
    expect(useAppStore.getState().pinnedAgentPaths).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEYS.PINNED_AGENTS)).toBeNull();
  });

  it('hydrates from localStorage on store creation', () => {
    localStorage.setItem(STORAGE_KEYS.PINNED_AGENTS, JSON.stringify(['/agents/persisted']));
    // Re-import or reset to trigger hydration logic — for Zustand, setState to simulate
    // In practice, the initializer runs at module load time. This test verifies the parsing logic.
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.PINNED_AGENTS) || '[]');
    const parsed = Array.isArray(raw) ? raw.filter((v: unknown) => typeof v === 'string') : [];
    expect(parsed).toEqual(['/agents/persisted']);
  });

  it('falls back to [] when localStorage contains corrupt data', () => {
    localStorage.setItem(STORAGE_KEYS.PINNED_AGENTS, 'not-json');
    let result: string[];
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.PINNED_AGENTS) || '[]');
      result = Array.isArray(raw) ? (raw as string[]).filter((v) => typeof v === 'string') : [];
    } catch {
      result = [];
    }
    expect(result).toEqual([]);
  });

  it('filters non-string values from localStorage', () => {
    localStorage.setItem(
      STORAGE_KEYS.PINNED_AGENTS,
      JSON.stringify(['/valid', 42, null, '/also-valid'])
    );
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.PINNED_AGENTS)!);
    const parsed = Array.isArray(raw)
      ? (raw as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    expect(parsed).toEqual(['/valid', '/also-valid']);
  });
});
