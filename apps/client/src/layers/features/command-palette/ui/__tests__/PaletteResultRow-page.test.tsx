// @vitest-environment jsdom
/**
 * An extension page as a ⌘K row (spec `flow-multiproject` §6.5): it reads as
 * the page's title under "Add-ons", and choosing it goes to the page.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Command, CommandList } from '@/layers/shared/ui';
import { PaletteResultRow } from '../PaletteResultRow';
import { RESULT_GROUP_LABEL } from '../palette-constants';
import type { RankedRow } from '../../model/palette-ranking';
import type { SearchResult } from '../../model/use-palette-search';

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

function pageRow(
  icon?: unknown,
  app: { state: 'ok' | 'held' | 'error' | 'off'; count?: number } = { state: 'ok' }
): RankedRow<SearchResult> {
  return {
    key: 'flow:',
    item: {
      item: {
        id: 'flow:',
        name: 'Flow',
        type: 'page',
        usageKey: null,
        lastActivityAt: null,
        waiting: false,
        demoted: false,
        scopes: [],
        data: {
          id: 'app:flow',
          label: 'Flow',
          href: '/x/flow',
          icon,
          app: { id: 'flow', path: '', state: app.state },
          count: app.count ?? 0,
        },
      },
      matches: undefined,
    },
    score: 1,
    signals: {} as RankedRow<SearchResult>['signals'],
    demoted: false,
  };
}

describe('PaletteResultRow — an app', () => {
  it('is headed "Apps" in the ranked list', () => {
    expect(RESULT_GROUP_LABEL.page).toBe('Apps');
  });

  function renderRow(row: RankedRow<SearchResult>, onPageSelect = vi.fn()) {
    return render(
      <Command>
        <CommandList>
          <PaletteResultRow
            row={row}
            selectedCwd={null}
            selectedValue=""
            onFeatureAction={vi.fn()}
            onQuickAction={vi.fn()}
            onGoToAgentActions={vi.fn()}
            onRoomSelect={vi.fn()}
            onSessionSelect={vi.fn()}
            onCommandSelect={vi.fn()}
            onPageSelect={onPageSelect}
          />
        </CommandList>
      </Command>
    );
  }

  it.each([
    ['not a component', { name: 'flow' }],
    [
      'a component that throws',
      () => {
        throw new Error('boom');
      },
    ],
  ])('still draws the row when the icon is %s', (_label, icon) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderRow(pageRow(icon));
    expect(screen.getByRole('option', { name: /^Flow/ })).toBeTruthy();
  });

  it('shows the page title and hands its address over when chosen', () => {
    const onPageSelect = vi.fn();
    render(
      <Command>
        <CommandList>
          <PaletteResultRow
            row={pageRow()}
            selectedCwd={null}
            selectedValue=""
            onFeatureAction={vi.fn()}
            onQuickAction={vi.fn()}
            onGoToAgentActions={vi.fn()}
            onRoomSelect={vi.fn()}
            onSessionSelect={vi.fn()}
            onCommandSelect={vi.fn()}
            onPageSelect={onPageSelect}
          />
        </CommandList>
      </Command>
    );

    fireEvent.click(screen.getByRole('option', { name: /^Flow/ }));
    expect(onPageSelect).toHaveBeenCalledWith('/x/flow', { id: 'flow', path: '', state: 'ok' });
  });

  it.each([
    ['held', 'Needs your OK'],
    ['error', 'Not working'],
  ] as const)(
    'says a %s app’s state, and hands the app over so choosing it never approves',
    (state, words) => {
      const onPageSelect = vi.fn();
      renderRow(pageRow(undefined, { state }), onPageSelect);
      const option = screen.getByRole('option', { name: new RegExp(`^Flow.*${words}`) });
      fireEvent.click(option);
      expect(onPageSelect).toHaveBeenCalledWith('/x/flow', { id: 'flow', path: '', state });
    }
  );

  it('shows a running app’s own count, else the word App', () => {
    renderRow(pageRow(undefined, { state: 'ok', count: 2 }));
    expect(screen.getByRole('option', { name: /^Flow/ })).toHaveTextContent('2');
    cleanup();
    renderRow(pageRow());
    expect(screen.getByRole('option', { name: /^Flow/ })).toHaveTextContent('App');
  });
});
