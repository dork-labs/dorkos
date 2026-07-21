/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { MAX_FILE_EXPLORER_ENTRIES } from '../model/file-explorer-persistence';

const STATE_KEY = 'dorkos-file-explorer-state';
const SHOW_HIDDEN_KEY = 'dorkos-file-explorer-show-hidden';

/**
 * Reset the module-level store and localStorage. The store is a singleton, so
 * without this its state (and any persisted blob) would leak between tests.
 */
function reset() {
  localStorage.clear();
  useFileExplorerStore.setState({
    showHidden: false,
    commands: null,
    scopeKey: null,
    expanded: {},
    selectedPath: null,
    scrollTop: 0,
  });
}

/** Parse the persisted per-cwd map straight from localStorage. */
function readMap(): Record<string, { accessedAt: number }> {
  return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
}

describe('useFileExplorerStore — per-cwd persistence', () => {
  beforeEach(reset);

  it('hydrates defaults for an unknown cwd', () => {
    useFileExplorerStore.getState().loadExplorerForCwd('/repo');
    const s = useFileExplorerStore.getState();
    expect(s.scopeKey).toBe('/repo');
    expect(s.expanded).toEqual({});
    expect(s.selectedPath).toBeNull();
    expect(s.scrollTop).toBe(0);
  });

  it('write-through persists each setter and restores it for a known cwd', () => {
    const store = useFileExplorerStore.getState();
    store.loadExplorerForCwd('/repo');
    store.setDirExpanded('src', true);
    store.setSelectedPath('src/index.ts');
    store.setScrollTop(240);

    // Switch away, then back → the entry restores exactly (from localStorage).
    store.loadExplorerForCwd('/other');
    store.loadExplorerForCwd('/repo');
    const s = useFileExplorerStore.getState();
    expect(s.expanded).toEqual({ src: true });
    expect(s.selectedPath).toBe('src/index.ts');
    expect(s.scrollTop).toBe(240);
  });

  it('isolates state per cwd', () => {
    const store = useFileExplorerStore.getState();
    store.loadExplorerForCwd('/a');
    store.setDirExpanded('src', true);
    store.loadExplorerForCwd('/b');
    // A fresh cwd starts empty, not inheriting /a's expansion.
    expect(useFileExplorerStore.getState().expanded).toEqual({});
  });

  it('evicts the least-recently-used entry past the cap', () => {
    // Deterministic accessedAt so LRU ordering is not clock-dependent.
    let clock = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock++);
    const store = useFileExplorerStore.getState();
    for (let i = 0; i < MAX_FILE_EXPLORER_ENTRIES + 5; i++) {
      store.loadExplorerForCwd(`/repo-${i}`);
      store.setScrollTop(i); // a distinct write to advance recency
    }
    spy.mockRestore();

    const map = readMap();
    expect(Object.keys(map)).toHaveLength(MAX_FILE_EXPLORER_ENTRIES);
    // The five earliest cwds were evicted; the newest survives.
    expect(map['/repo-0']).toBeUndefined();
    expect(map['/repo-4']).toBeUndefined();
    expect(map[`/repo-${MAX_FILE_EXPLORER_ENTRIES + 4}`]).toBeDefined();
  });

  it('setShowHidden persists globally and round-trips', () => {
    useFileExplorerStore.getState().setShowHidden(true);
    expect(localStorage.getItem(SHOW_HIDDEN_KEY)).toBe('true');
    useFileExplorerStore.getState().setShowHidden(false);
    expect(localStorage.getItem(SHOW_HIDDEN_KEY)).toBe('false');
  });

  it('pruneMissing drops expanded/selected paths that no longer exist', () => {
    const store = useFileExplorerStore.getState();
    store.loadExplorerForCwd('/repo');
    store.setDirExpanded('src', true);
    store.setDirExpanded('src/gone', true);
    store.setDirExpanded('src/gone/deep', true);
    store.setSelectedPath('src/gone/file.ts');

    // The `src` listing arrives without `gone`.
    store.pruneMissing('src', ['index.ts']);

    const s = useFileExplorerStore.getState();
    expect(s.expanded).toEqual({ src: true }); // gone + its descendant dropped
    expect(s.selectedPath).toBeNull();
  });

  it('pruneMissing is a no-op when nothing is stale', () => {
    const store = useFileExplorerStore.getState();
    store.loadExplorerForCwd('/repo');
    store.setDirExpanded('src', true);
    const before = useFileExplorerStore.getState().expanded;

    store.pruneMissing('', ['src', 'README.md']);
    // Same reference → no churn, no needless persist.
    expect(useFileExplorerStore.getState().expanded).toBe(before);
  });

  it('remapExpandedPaths rewrites an open/selected subtree after a rename', () => {
    const store = useFileExplorerStore.getState();
    store.loadExplorerForCwd('/repo');
    store.setDirExpanded('src', true);
    store.setDirExpanded('src/old', true);
    store.setSelectedPath('src/old/file.ts');

    store.remapExpandedPaths('src/old', 'src/new');

    const s = useFileExplorerStore.getState();
    expect(s.expanded).toEqual({ src: true, 'src/new': true });
    expect(s.selectedPath).toBe('src/new/file.ts');
  });

  it('dropExpandedPaths clears an open/selected subtree after a delete', () => {
    const store = useFileExplorerStore.getState();
    store.loadExplorerForCwd('/repo');
    store.setDirExpanded('src', true);
    store.setDirExpanded('src/pkg', true);
    store.setSelectedPath('src/pkg/file.ts');

    store.dropExpandedPaths('src/pkg');

    const s = useFileExplorerStore.getState();
    expect(s.expanded).toEqual({ src: true });
    expect(s.selectedPath).toBeNull();
  });

  it('recovers from corrupted JSON by falling back to defaults', () => {
    localStorage.setItem(STATE_KEY, '{ not json');
    useFileExplorerStore.getState().loadExplorerForCwd('/repo');
    const s = useFileExplorerStore.getState();
    expect(s.expanded).toEqual({});
    expect(s.selectedPath).toBeNull();
    expect(s.scrollTop).toBe(0);
  });
});
