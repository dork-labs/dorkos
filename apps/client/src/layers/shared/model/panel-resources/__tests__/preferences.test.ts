// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../app-store/app-store';
import {
  documentPanelScope,
  legacyDocumentPanelScope,
  readPanelViewPreferences,
  remapClosedPanelDocument,
  remapClosedPanelScope,
} from '../preferences';

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ panelViewPreferences: {} });
});
afterEach(() => vi.restoreAllMocks());

describe('panel view preference ownership', () => {
  it('bounds persisted contexts and IDs and remains usable when storage is blocked', () => {
    const store = useAppStore.getState();
    for (let index = 0; index < 55; index++)
      store.updatePanelViewPreference(`agent:${index}`, () => ({
        opened: Array.from({ length: 105 }, (_, id) => `view-${id}`),
        closed: Array.from({ length: 105 }, (_, id) => `closed-${id}`),
      }));
    const persisted = readPanelViewPreferences();
    expect(Object.keys(persisted)).toHaveLength(50);
    expect(persisted['agent:0']).toBeUndefined();
    expect(persisted['agent:54'].opened).toHaveLength(100);
    expect(persisted['agent:54'].closed).toHaveLength(100);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    store.updatePanelViewPreference('memory', () => ({ opened: ['canvas'], closed: ['local'] }));
    expect(useAppStore.getState().panelViewPreferences.memory).toEqual({
      opened: ['canvas'],
      closed: ['local'],
    });
  });

  it('ignores malformed or oversized persisted entries without losing valid choices', () => {
    localStorage.setItem(
      'dorkos-panel-views-v1',
      JSON.stringify({
        valid: { opened: ['canvas'], closed: [] },
        malformed: { opened: [42], closed: [] },
        oversized: { opened: [], closed: Array(101).fill('x') },
      })
    );
    expect(readPanelViewPreferences()).toEqual({ valid: { opened: ['canvas'], closed: [] } });
    localStorage.setItem('dorkos-panel-views-v1', '{');
    expect(readPanelViewPreferences()).toEqual({});
  });

  it('remaps exact optimistic IDs and owner scopes without touching neighboring IDs, directories, terminals or mini apps', () => {
    const old = legacyDocumentPanelScope('draft', '/cwd');
    const next = documentPanelScope('canonical', '/cwd');
    const pending = `${old}:resource/pending:abc`;
    const preferences = {
      agent: {
        opened: ['canvas'],
        closed: [
          pending,
          `${old}:resource/pending:abc-more`,
          `${old}-more:resource/pending:abc`,
          `${old}:resource/terminal/pty`,
          'resource:miniapp',
        ],
      },
    };
    const settled = remapClosedPanelDocument(preferences, [old], 'pending:abc', 'server');
    expect(settled.agent.closed).toEqual([
      `${old}:resource/server`,
      ...preferences.agent.closed.slice(1),
    ]);
    const carried = remapClosedPanelScope(settled, old, next);
    expect(carried.agent.closed).toEqual([
      `${next}:resource/server`,
      `${next}:resource/pending:abc-more`,
      `${old}-more:resource/pending:abc`,
      `${old}:resource/terminal/pty`,
      'resource:miniapp',
    ]);
    expect(documentPanelScope('a:b', 'c')).not.toBe(documentPanelScope('a', 'b:c'));
  });

  it('merges canonical owner buckets instead of losing already recorded closures', () => {
    const old = documentPanelScope('draft', '/cwd');
    const next = documentPanelScope('canonical', '/cwd');
    const moved = remapClosedPanelScope(
      {
        [`documents:${old}`]: { opened: [], closed: [`${old}:resource/one`] },
        [`documents:${next}`]: { opened: [], closed: [`${next}:resource/two`] },
      },
      old,
      next
    );
    expect(Object.keys(moved)).toEqual([`documents:${next}`]);
    expect(moved[`documents:${next}`].closed).toEqual([
      `${next}:resource/one`,
      `${next}:resource/two`,
    ]);
  });
});
