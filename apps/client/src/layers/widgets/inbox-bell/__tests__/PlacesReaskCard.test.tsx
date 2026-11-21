/**
 * Apps that ask again only because they now say where they show share one
 * Inbox card (DOR-4282): which rows it holds, how many it shows, how a row
 * answers, and when the card leaves.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { isPlacesOnlyReask, newPlacesLine } from '../lib/places-reask';
import { usePlacesReaskGroup, type PlacesGroupRow } from '../model/use-places-reask-group';
import { PlacesReaskCard } from '../ui/PlacesReaskCard';

afterEach(cleanup);

/** A made-up app that keeps running while these newly declared places wait. */
function reask(name: string, slots: string[] = ['pages']): PendingExtensionApproval {
  const id = name.toLowerCase();
  return {
    id,
    name,
    version: '1.1.0',
    path: `/home/me/.dork/plugins/${id}/extensions/${id}`,
    plugin: id,
    sourceLabel: 'from dork-labs/marketplace',
    runsInServer: false,
    adds: null,
    since: '2026-11-19T12:00:00.000Z',
    why: `You installed ${name}.`,
    permissions: { runtime: 'in-process', net: [], run: [], agents: false, hasPage: true, slots },
    added: { net: [], run: [], agents: false, runtime: false, slots },
    agentTools: [],
    agentSkills: [],
    digest: null,
    changedFiles: null,
    updatedFrom: null,
    placesOnly: true,
  };
}

const NAMES = ['Atlas', 'Beacon', 'Cinder', 'Drift', 'Ember', 'Grove', 'Harbor'];

describe('which re-asks share the card', () => {
  // Purpose: only a re-ask that adds places and nothing else is grouped.
  it('groups places-only re-asks, never one that adds a power', () => {
    expect(isPlacesOnlyReask(reask('Atlas'))).toBe(true);
    const base = reask('Beacon');
    for (const added of [
      { ...base.added!, net: ['api.example.com'] },
      { ...base.added!, run: ['git'] },
      { ...base.added!, agents: true },
      { ...base.added!, runtime: true },
      { ...base.added!, apps: ['planner'] },
    ]) {
      expect(isPlacesOnlyReask({ ...base, added })).toBe(false);
    }
    expect(isPlacesOnlyReask({ ...base, added: null })).toBe(false);
    expect(isPlacesOnlyReask({ ...base, added: { ...base.added!, slots: [] } })).toBe(false);
  });

  // Purpose: only the server decides an app keeps running; a row paused for
  // changed files, or one from a server that never says, keeps its own card.
  it('groups only rows the server marks as running', () => {
    const paused = {
      ...reask('Beacon'),
      placesOnly: false,
      changedFiles: ['extension.json'],
      updatedFrom: '1.0.0',
    };
    expect(isPlacesOnlyReask(paused)).toBe(false);
    const { placesOnly: _placesOnly, ...older } = reask('Cinder');
    expect(isPlacesOnlyReask(older as PendingExtensionApproval)).toBe(false);
  });

  // Purpose: the places are named in DorkOS's own words.
  it('names the new places in DorkOS’s words', () => {
    expect(newPlacesLine(reask('Atlas', ['status-bar', 'pages']))).toBe(
      'adds a page and a status bar item'
    );
    expect(newPlacesLine(reask('Atlas', ['<b>x</b>', 'pages']))).toBe('adds a page');
  });

  // Purpose: two or more share one card; a power row keeps its own.
  it('puts two or more in the card and leaves the power row out', () => {
    const power = {
      ...reask('Weather'),
      added: { ...reask('Weather').added!, net: ['a.example'] },
    };
    const { result } = renderHook(() =>
      usePlacesReaskGroup([reask('Atlas'), power, reask('Beacon')])
    );
    expect(result.current.rows.map((row) => row.approval.id)).toEqual(['atlas', 'beacon']);
    expect(result.current.rest.map((approval) => approval.id)).toEqual(['weather']);
  });

  // Purpose: one alone keeps its normal card.
  it('keeps a single places-only re-ask on its own card', () => {
    const { result } = renderHook(() => usePlacesReaskGroup([reask('Atlas')]));
    expect(result.current.rows).toEqual([]);
    expect(result.current.rest.map((approval) => approval.id)).toEqual(['atlas']);
  });

  // Purpose: an answered row stays, collapsed, and the card leaves once
  // every row is answered.
  it('collapses an answered row and drops the card once all are answered', () => {
    const atlas = reask('Atlas');
    const beacon = reask('Beacon');
    const { result, rerender } = renderHook(({ list }) => usePlacesReaskGroup(list), {
      initialProps: { list: [atlas, beacon] },
    });

    act(() => result.current.answered(atlas, 'allowed'));
    // The server no longer lists it once allowed.
    rerender({ list: [beacon] });
    expect(result.current.rows).toEqual([
      { approval: atlas, answer: 'allowed' },
      { approval: beacon, answer: null },
    ]);
    expect(result.current.rest).toEqual([]);

    act(() => result.current.answered(beacon, 'not-now'));
    rerender({ list: [] });
    expect(result.current.rows).toEqual([]);
  });
});

describe('a row answered while its answer is sent', () => {
  // Purpose: the row keeps its place while the answer is sent, and a refused
  // answer puts it back where it stood, still waiting.
  it('keeps an answered row in place, and puts a refused one back', () => {
    const [atlas, beacon, cinder] = ['Atlas', 'Beacon', 'Cinder'].map((name) => reask(name));
    const { result, rerender } = renderHook(({ list }) => usePlacesReaskGroup(list), {
      initialProps: { list: [atlas!, beacon!, cinder!] },
    });

    act(() => result.current.answered(beacon!, 'not-now'));
    // Not now takes the row out of the cached queue at once.
    rerender({ list: [atlas!, cinder!] });
    expect(result.current.rows.map((row) => [row.approval.id, row.answer])).toEqual([
      ['atlas', null],
      ['beacon', 'not-now'],
      ['cinder', null],
    ]);

    act(() => result.current.retracted(beacon!));
    rerender({ list: [atlas!, beacon!, cinder!] });
    expect(result.current.rows.map((row) => [row.approval.id, row.answer])).toEqual([
      ['atlas', null],
      ['beacon', null],
      ['cinder', null],
    ]);
  });

  // Purpose: the last answer never drops a still-listed row onto a card of
  // its own while the server has not taken it yet.
  it('keeps the last allowed row off its own card until the server stops listing it', () => {
    const atlas = reask('Atlas');
    const beacon = reask('Beacon');
    const { result, rerender } = renderHook(({ list }) => usePlacesReaskGroup(list), {
      initialProps: { list: [atlas, beacon] },
    });
    act(() => result.current.answered(atlas, 'not-now'));
    act(() => result.current.answered(beacon, 'allowed'));
    rerender({ list: [beacon] });
    expect(result.current.rest).toEqual([]);
    act(() => result.current.confirmed(atlas));
    act(() => result.current.confirmed(beacon));
    rerender({ list: [] });
    expect(result.current.rows).toEqual([]);
    expect(result.current.rest).toEqual([]);
  });
});

/** Rows of the card, none answered. */
function rowsOf(count: number): PlacesGroupRow[] {
  return NAMES.slice(0, count).map((name) => ({ approval: reask(name), answer: null }));
}

describe('PlacesReaskCard', () => {
  // Purpose: the first five rows, then "Show N more".
  it('shows five rows, then the rest behind "Show N more"', async () => {
    render(
      <PlacesReaskCard rows={rowsOf(7)} pending={null} onAllow={vi.fn()} onNotNow={vi.fn()} />
    );
    expect(screen.getByText('7 apps need a quick look')).toBeInTheDocument();
    expect(
      screen.getByText('They keep working. Each new place stays off until you allow it.')
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByText(/paused/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
  });

  // Purpose: each row answers alone, through its own Allow and Not now.
  it('answers one row at a time, with no way to allow them all', async () => {
    const onAllow = vi.fn();
    const onNotNow = vi.fn();
    const rows = rowsOf(3);
    render(<PlacesReaskCard rows={rows} pending={null} onAllow={onAllow} onNotNow={onNotNow} />);

    await userEvent.click(screen.getByRole('button', { name: 'Allow Beacon' }));
    expect(onAllow).toHaveBeenCalledWith(rows[1]);
    await userEvent.click(screen.getByRole('button', { name: 'Not now for Cinder' }));
    expect(onNotNow).toHaveBeenCalledWith(rows[2]);
    expect(screen.queryByRole('button', { name: /allow all|all apps/i })).not.toBeInTheDocument();
  });

  // Purpose: on a phone the buttons drop below the text instead of squeezing
  // it to a letter a line (jsdom has no layout, so this pins the classes: a
  // wrapping row, and text that starts at 9rem rather than at nothing).
  it('lets the buttons wrap below the text on a narrow card', () => {
    render(
      <PlacesReaskCard rows={rowsOf(1)} pending={null} onAllow={vi.fn()} onNotNow={vi.fn()} />
    );
    const row = screen.getByTestId('places-reask-row-atlas');
    expect(row.className).toMatch(/\bflex-wrap\b/);
    const text = row.querySelector('p')!;
    expect(text.className).toMatch(/\bbasis-36\b/);
    expect(text.className).toMatch(/\bmin-w-0\b/);
  });

  // Purpose: an allowed row collapses to "Allowed ✓".
  it('collapses an allowed row', () => {
    const rows = rowsOf(2);
    rows[0] = { ...rows[0], answer: 'allowed' };
    render(<PlacesReaskCard rows={rows} pending={null} onAllow={vi.fn()} onNotNow={vi.fn()} />);

    const row = screen.getByTestId('places-reask-row-atlas');
    expect(row).toHaveTextContent('Atlas · Allowed');
    expect(row.querySelector('button')).toBeNull();
    expect(screen.getByText('1 app needs a quick look')).toBeInTheDocument();
  });

  // Purpose: the card leaves once every row is answered.
  it('draws nothing once every row is answered', () => {
    const rows = rowsOf(2).map((row) => ({ ...row, answer: 'allowed' as const }));
    const { container } = render(
      <PlacesReaskCard rows={rows} pending={null} onAllow={vi.fn()} onNotNow={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
