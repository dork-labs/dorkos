/**
 * "It uses other apps:" on an approval card (DOR-3293, the designer's spec):
 * one row per app in DorkOS's words, a missing app says that part won't work,
 * only an app new since the last yes is marked New, and past four the rest
 * open in place.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ExtensionPermissionLines } from '../ui/ExtensionPermissionLines';
import {
  approvedSetOf,
  extensionPermissionLines,
  permissionLineText,
  permissionsAddedSince,
  type ExtensionPermissionView,
} from '../lib/permission-lines';

afterEach(cleanup);

const view = (apps: ExtensionPermissionView['apps']): ExtensionPermissionView => ({
  runtime: 'in-process',
  net: [],
  run: [],
  agents: false,
  hasServer: false,
  apps,
});

const THREE = view([
  { id: 'desk', name: 'Desk', access: 'reads' },
  { id: 'mkt-core', name: 'Marketing core', access: 'both' },
  { id: 'ledger', name: null, access: null },
]);

describe('It uses other apps', () => {
  it('reads one line per app, in the designer’s words', () => {
    const line = extensionPermissionLines(THREE).find((entry) => entry.key === 'apps');
    expect(line && permissionLineText(line)).toBe(
      'It uses other apps: Desk · reads Marketing core · reads and changes ' +
        'ledger · not installed, so this part won’t work'
    );
  });

  it('says so when an installed app shares nothing with it', () => {
    const line = extensionPermissionLines(
      view([{ id: 'vault', name: 'Vault', access: null }])
    ).find((entry) => entry.key === 'apps');
    expect(line?.apps?.[0]?.detail).toBe('shares nothing, so this part won’t work');
  });

  it('draws a missing app as an id in mono, never as a name in bold', () => {
    render(<ExtensionPermissionLines permissions={THREE} />);
    const id = document.querySelector('li[data-app="ledger"] bdi');
    expect(id).toHaveTextContent('ledger');
    expect(id).toHaveClass('font-mono');
    expect(id).not.toHaveClass('font-semibold');
    const name = document.querySelector('li[data-app="desk"] bdi');
    expect(name).toHaveClass('font-semibold');
    expect(name).not.toHaveClass('font-mono');
  });

  it('keeps only the characters an id allows, cut short, for an id the asking app chose', () => {
    const line = extensionPermissionLines(
      view([
        { id: 'Google Drive (official)', name: null, access: null },
        { id: `a${'b'.repeat(80)}`, name: null, access: null },
      ])
    ).find((entry) => entry.key === 'apps');
    const [hostile, long] = line?.apps ?? [];
    expect(hostile?.name).toBe('oogleriveofficial');
    expect(hostile?.name).toMatch(/^[a-z0-9-]+$/);
    expect(long?.name).toBe(`a${'b'.repeat(31)}…`);
  });

  it('draws nothing for an app that calls no other app', () => {
    expect(extensionPermissionLines(view(undefined)).some((l) => l.key === 'apps')).toBe(false);
    expect(extensionPermissionLines(view([])).some((l) => l.key === 'apps')).toBe(false);
  });

  it('marks only the app new since the last yes', () => {
    render(
      <ExtensionPermissionLines
        permissions={THREE}
        added={{ net: [], run: [], agents: false, runtime: false, apps: ['mkt-core'] }}
      />
    );
    const rows = document.querySelectorAll('[data-slot="called-apps"] li[data-app]');
    expect([...rows].map((row) => row.getAttribute('data-new'))).toEqual([null, 'true', null]);
    expect(screen.getAllByText('New')).toHaveLength(1);
  });

  it('shows four, then “and N more”, which opens the rest in place', () => {
    const six = view(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id.toUpperCase(), access: 'reads' }))
    );
    render(<ExtensionPermissionLines permissions={six} />);
    expect(document.querySelectorAll('li[data-app]')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'and 2 more' }));
    expect(document.querySelectorAll('li[data-app]')).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /more/ })).not.toBeInTheDocument();
  });

  it('echoes the apps it showed with a yes, so a list that grew since is refused as stale', () => {
    expect(approvedSetOf(THREE)?.apps).toEqual(['desk', 'mkt-core', 'ledger']);
    // And what each shared, so a target that shares more since is refused too.
    expect(approvedSetOf(THREE)?.appAccess).toEqual({ desk: 'reads', 'mkt-core': 'both' });
    expect(approvedSetOf(view(undefined))).not.toHaveProperty('apps');
  });

  it('finds a newly listed app between what was seen and what is declared now', () => {
    const seen = {
      runtime: 'in-process' as const,
      net: [],
      run: [],
      agents: false,
      apps: ['desk'],
    };
    expect(permissionsAddedSince(seen, { ...seen, apps: ['desk', 'ledger'] })?.apps).toEqual([
      'ledger',
    ]);
    expect(permissionsAddedSince(seen, { ...seen, apps: [] })).toBeNull();
  });
});

describe('It can change (Security item 8)', () => {
  it('lists, in DorkOS’s words, every write a fixture app that writes can make', () => {
    const writer: ExtensionPermissionView = {
      runtime: 'in-process',
      net: [],
      run: [],
      agents: false,
      hasServer: false,
      hasPage: true,
      writes: ['data', 'canvas', 'inbox', 'work', 'files', 'rooms', 'forward'],
      apps: [
        { id: 'desk', name: 'Desk', access: 'reads' },
        { id: 'mkt-core', name: 'Marketing core', access: 'both' },
      ],
    };
    render(<ExtensionPermissionLines permissions={writer} />);
    const rows = [...document.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toMatchInlineSnapshot(`
      [
        "It can change:Its own saved data and project settingsDocuments it opens on your canvasIts own items in your inboxWork for an agent, started only when you clickNew files on your computer, only when you choose SaveReplies in the room threads you pickMessages to an agent you pick, sent in your name",
        "Its own saved data and project settings",
        "Documents it opens on your canvas",
        "Its own items in your inbox",
        "Work for an agent, started only when you click",
        "New files on your computer, only when you choose Save",
        "Replies in the room threads you pick",
        "Messages to an agent you pick, sent in your name",
        "It uses other apps:Desk · readsMarketing core · reads and changes",
        "Desk · reads",
        "Marketing core · reads and changes",
      ]
    `);
  });

  it('says a fixture app with no writes can’t change anything, keeping the block', () => {
    const quiet: ExtensionPermissionView = {
      runtime: 'in-process',
      net: [],
      run: [],
      agents: false,
      hasServer: false,
      hasPage: false,
      writes: [],
    };
    render(<ExtensionPermissionLines permissions={quiet} />);
    const rows = [...document.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toMatchInlineSnapshot(`
      [
        "It can change:It can’t change anything.",
        "It can’t change anything.",
      ]
    `);
  });

  it('draws no block where the server sent nothing to go on', () => {
    const keys = extensionPermissionLines(view(undefined)).map((entry) => entry.key);
    expect(keys).not.toContain('writes');
  });
});
