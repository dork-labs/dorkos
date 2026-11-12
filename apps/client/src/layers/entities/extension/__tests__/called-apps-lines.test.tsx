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
  calledAppDetail,
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
  { id: 'mkt-core', name: 'Marketing core', access: 'both', opens: true },
  { id: 'ledger', name: null, access: null },
]);

/** The words after each app's name, as the card draws them. */
const rowsOf = (apps: ExtensionPermissionView['apps']): string[] | undefined =>
  extensionPermissionLines(view(apps))
    .find((line) => line.key === 'apps')
    ?.apps?.map((app) => `${app.name} · ${app.detail}`);

describe('It uses other apps', () => {
  it('reads one line per app, in the designer’s words', () => {
    const line = extensionPermissionLines(THREE).find((entry) => entry.key === 'apps');
    expect(line && permissionLineText(line)).toBe(
      'It uses other apps: Desk · reads ' +
        'Marketing core · reads and changes · can open its pages ' +
        'ledger · not installed, so this part won’t work'
    );
  });

  // Only real powers: what the target exports to this app, and its own navigate (Nov 11).
  it.each([
    [
      'writes it may use, and opens',
      { access: 'both', opens: true },
      'Mkt Newsletter · reads and changes · can open its pages',
    ],
    ['writes it may use, no opening', { access: 'both' }, 'Mkt Newsletter · reads and changes'],
    ['only reads', { access: 'reads' }, 'Mkt Newsletter · reads'],
    [
      'only reads, and opens',
      { access: 'reads', opens: true },
      'Mkt Newsletter · reads · can open its pages',
    ],
    [
      'nothing shared, but opens',
      { access: null, opens: true },
      'Mkt Newsletter · can only open its pages',
    ],
  ] as const)('%s', (_name, power, row) => {
    expect(rowsOf([{ id: 'mkt-newsletter', name: 'Mkt Newsletter', ...power }])).toEqual([row]);
  });

  it('mkt-core → mkt-newsletter, which exports nothing to it: opens only', () => {
    expect(
      rowsOf([{ id: 'mkt-newsletter', name: 'Mkt Newsletter', access: null, opens: true }])
    ).toEqual(['Mkt Newsletter · can only open its pages']);
  });

  it('leaves off an app that gives it no power, and the whole line when none do', () => {
    expect(
      rowsOf([
        { id: 'desk', name: 'Desk', access: 'reads' },
        { id: 'vault', name: 'Vault', access: null },
        { id: 'quiet', name: 'Quiet', access: null, opens: false },
      ])
    ).toEqual(['Desk · reads']);
    expect(rowsOf([{ id: 'vault', name: 'Vault', access: null }])).toBeUndefined();
    // But the yes still echoes it, so a target that starts sharing asks again.
    expect(approvedSetOf(view([{ id: 'vault', name: 'Vault', access: null }]))?.apps).toEqual([
      'vault',
    ]);
  });

  it('names the extra power after the app only when it applies (designer, Nov 11)', () => {
    expect(calledAppDetail({ installed: true, access: 'both', opensPages: false })).toBe(
      'reads and changes'
    );
    expect(calledAppDetail({ installed: true, access: 'both', opensPages: true })).toBe(
      'reads and changes · can open its pages'
    );
    expect(calledAppDetail({ installed: true, access: null, opensPages: true })).toBe(
      'can only open its pages'
    );
    // No power at all: no row.
    expect(calledAppDetail({ installed: true, access: null, opensPages: false })).toBeNull();
    expect(calledAppDetail({ installed: false, access: null, opensPages: true })).toBe(
      'not installed, so this part won’t work'
    );
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

  // A manifest that names another app by anything but an id is refused when
  // it is read (Security, DOR-3293), so the card shows the declared id as is,
  // only cut short.
  it('shows a missing app’s id exactly as declared, cut at 32 characters', () => {
    const long = `a${'b'.repeat(80)}`;
    const line = extensionPermissionLines(
      view([
        { id: 'mkt-core', name: null, access: null },
        { id: long, name: null, access: null },
      ])
    ).find(({ key }) => key === 'apps');
    const [plainId, longId] = line?.apps ?? [];
    expect(plainId?.name).toBe('mkt-core');
    expect(longId?.name).toBe(`${long.slice(0, 32)}…`);
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
    // And which it opens, so an update that starts opening one is refused too.
    expect(approvedSetOf(THREE)?.appOpens).toEqual(['mkt-core']);
    expect(approvedSetOf(view([{ id: 'desk', name: 'Desk', access: 'reads' }]))).not.toHaveProperty(
      'appOpens'
    );
    expect(approvedSetOf(view(undefined))).not.toHaveProperty('apps');
  });

  it('finds an app newly opened between what was seen and what is declared now', () => {
    const seen = {
      runtime: 'in-process' as const,
      net: [],
      run: [],
      agents: false,
      apps: ['desk'],
    };
    expect(permissionsAddedSince(seen, { ...seen, appOpens: ['desk'] })?.apps).toEqual(['desk']);
    expect(permissionsAddedSince({ ...seen, appOpens: ['desk'] }, seen)).toBeNull();
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
