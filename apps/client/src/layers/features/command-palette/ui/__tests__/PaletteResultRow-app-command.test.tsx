// @vitest-environment jsdom
/**
 * An app's ⌘K command names the app after its label, so every app command says
 * which app it came from (DOR-4282). DorkOS's own commands carry no name.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Command, CommandList } from '@/layers/shared/ui';
import { PaletteResultRow } from '../PaletteResultRow';
import type { RankedRow } from '../../model/palette-ranking';
import type { SearchResult } from '../../model/use-palette-search';
import type { FeatureItem } from '../../model/use-palette-items';

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

function featureRow(data: FeatureItem): RankedRow<SearchResult> {
  return {
    key: data.id,
    item: {
      item: {
        id: data.id,
        name: data.label,
        type: 'feature',
        usageKey: null,
        lastActivityAt: null,
        waiting: false,
        demoted: false,
        scopes: [],
        data,
      },
      matches: undefined,
    },
    score: 1,
    signals: {} as RankedRow<SearchResult>['signals'],
    demoted: false,
  };
}

function renderRow(data: FeatureItem) {
  return render(
    <Command>
      <CommandList>
        <PaletteResultRow
          row={featureRow(data)}
          selectedCwd={null}
          selectedValue=""
          onFeatureAction={vi.fn()}
          onQuickAction={vi.fn()}
          onGoToAgentActions={vi.fn()}
          onRoomSelect={vi.fn()}
          onSessionSelect={vi.fn()}
          onCommandSelect={vi.fn()}
          onPageSelect={vi.fn()}
        />
      </CommandList>
    </Command>
  );
}

describe('PaletteResultRow — a command', () => {
  it('names the app after the label, with the name the row was given', () => {
    renderRow({
      id: 'planner:open-settings',
      label: 'Open settings',
      icon: 'Settings',
      action: 'ext:planner:open-settings',
      appName: 'Planner',
    });

    const option = screen.getByRole('option', { name: /Open settings/ });
    expect(option).toHaveTextContent('Open settings· Planner');
    expect(screen.getByTitle('Planner')).toBeInTheDocument();
  });

  it('draws no app name on DorkOS’s own command', () => {
    renderRow({ id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' });

    const option = screen.getByRole('option', { name: /Settings/ });
    expect(option).toHaveTextContent(/^Settings$/);
    expect(option).not.toHaveTextContent('·');
  });
});
