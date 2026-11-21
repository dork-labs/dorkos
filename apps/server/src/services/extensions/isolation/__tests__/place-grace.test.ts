/**
 * The places an app may show in now (DOR-4282): new places alone keep the
 * app running with only its old places, any other addition stops all of it,
 * and the grace an app approved before places were recorded gets, with every
 * condition that ends or denies it.
 */
import { describe, it, expect } from 'vitest';
import type { ExtensionManifest } from '@dorkos/extension-api';
import { allowedPlacesOf, placeGraceOf, waitingPlacesOf } from '../place-grace.js';
import {
  mayRunExtensionCode,
  type ExtensionApprovals,
  type ExtensionDeclaringCopy,
} from '../../extension-load-policy.js';

const PATH = '/home/me/.dork/plugins/ledger/extensions/ledger';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** A marketplace copy, installed by DorkOS from a source it proved. */
function installed(overrides: Partial<ExtensionDeclaringCopy> = {}): ExtensionDeclaringCopy {
  return {
    id: 'ledger',
    origin: 'user',
    path: PATH,
    scope: 'global',
    sourcePlugin: 'ledger',
    trustedOrigin: { plugin: 'ledger', source: 'dork-labs/marketplace' },
    currentDigest: DIGEST,
    manifest: { id: 'ledger', name: 'Ledger', version: '1.0.0' } as ExtensionManifest,
    ...overrides,
  };
}

/** A person's yes to that copy, given before places were recorded. */
function oldApproval(overrides: Partial<ExtensionApprovals> = {}): ExtensionApprovals {
  return {
    approvedToRun: ['ledger'],
    approvedSources: { ledger: { path: PATH, plugin: 'ledger', digest: DIGEST } },
    ...overrides,
  };
}

describe('placeGraceOf', () => {
  // Purpose: the two places the old card named keep showing undeclared.
  it('keeps the panel tab and Settings page of an old approval that declares nothing', () => {
    expect(placeGraceOf(installed(), oldApproval())).toEqual(['right-panel', 'settings.tabs']);
  });

  // Purpose: an old approval with a stored set but no `slots` still reads as old.
  it('reads an old in-process set with no places as old too', () => {
    const approvals = oldApproval({
      approvedPermissions: { ledger: { runtime: 'in-process', net: [], run: [], agents: false } },
    });
    expect(placeGraceOf(installed(), approvals)).toEqual(['right-panel', 'settings.tabs']);
  });

  // Purpose: a page is kept only when card text saved with the yes said so.
  it('keeps a page only under card text saved with the yes', () => {
    expect(placeGraceOf(installed(), oldApproval())).not.toContain('pages');
    expect(placeGraceOf(installed(), oldApproval(), 'This adds a page.')).toEqual([
      'pages',
      'right-panel',
      'settings.tabs',
    ]);
    expect(placeGraceOf(installed(), oldApproval(), 'This adds no page.')).not.toContain('pages');
  });

  // Purpose: ⌘K, dialogs, the status bar, the Inbox and the canvas are never kept.
  it('never keeps any other place', () => {
    const kept = placeGraceOf(installed(), oldApproval(), 'This adds a page.');
    for (const key of ['command-palette.items', 'dialog', 'status-bar', 'inbox', 'canvas']) {
      expect(kept).not.toContain(key);
    }
  });

  // Purpose: a place it declares shows anyway, so grace leaves it out.
  it('leaves out places it declares', () => {
    const copy = installed({
      manifest: {
        id: 'ledger',
        name: 'Ledger',
        version: '1.0.0',
        contributions: { 'right-panel': true },
      } as ExtensionManifest,
    });
    expect(placeGraceOf(copy, oldApproval())).toEqual(['settings.tabs']);
  });

  // Purpose: an approval that records places is held to them, with no grace.
  it('gives no grace to an approval that records places', () => {
    const approvals = oldApproval({
      approvedPermissions: {
        ledger: { runtime: 'in-process', net: [], run: [], agents: false, slots: [] },
      },
    });
    expect(placeGraceOf(installed(), approvals)).toEqual([]);
  });

  // Purpose: any change to the installed files ends it, an edit in place
  // or an update alike.
  it('ends the moment an installed file changes', () => {
    const edited = installed({ currentDigest: `sha256:${'b'.repeat(64)}` });
    expect(placeGraceOf(edited, oldApproval())).toEqual([]);
  });

  // Purpose: after an update and a fresh yes, the manifest rules.
  it('gives none once the update is approved, so the manifest rules', () => {
    const next = `sha256:${'c'.repeat(64)}`;
    const approvals = oldApproval({
      approvedSources: { ledger: { path: PATH, plugin: 'ledger', digest: next } },
      approvedPermissions: {
        ledger: { runtime: 'in-process', net: [], run: [], agents: false, slots: ['pages'] },
      },
    });
    expect(placeGraceOf(installed({ currentDigest: next }), approvals)).toEqual([]);
  });

  // Purpose: only a copy DorkOS's installer provably put there.
  it('gives none to a folder copied in by hand', () => {
    const direct = installed({
      path: '/home/me/.dork/extensions/ledger',
      sourcePlugin: undefined,
      trustedOrigin: undefined,
    });
    const approvals = oldApproval({
      approvedSources: { ledger: { path: '/home/me/.dork/extensions/ledger', digest: DIGEST } },
    });
    expect(placeGraceOf(direct, approvals)).toEqual([]);
  });

  // Purpose: a dev link gets none.
  it('gives none to a dev link', () => {
    const linked = installed({ devLink: { path: '/src/ledger' }, trustedOrigin: undefined });
    const approvals = oldApproval({
      approvedSources: {
        ledger: { path: PATH, plugin: 'ledger', digest: DIGEST, devLink: '/src/ledger' },
      },
    });
    expect(placeGraceOf(linked, approvals)).toEqual([]);
  });

  // Purpose: an app an agent made with `create_extension` gets none.
  it('gives none to an app an agent made', () => {
    for (const extra of [
      { autoApprovedBy: 'create_extension' as const },
      { authorHome: '/home/me/.dork/agents/a' },
    ]) {
      const approvals = oldApproval({
        approvedSources: { ledger: { path: PATH, plugin: 'ledger', digest: DIGEST, ...extra } },
      });
      expect(placeGraceOf(installed(), approvals)).toEqual([]);
    }
  });

  // Purpose: only the yes for this id and this very copy.
  it('gives none to another app or another copy', () => {
    expect(placeGraceOf(installed({ id: 'other' }), oldApproval())).toEqual([]);
    expect(placeGraceOf(installed({ path: '/elsewhere/ledger' }), oldApproval())).toEqual([]);
  });

  // Purpose: DorkOS's own apps never need it.
  it('gives none to a core app', () => {
    expect(placeGraceOf(installed({ origin: 'core' }), oldApproval())).toEqual([]);
  });
});

describe('new places wait on their own (option C)', () => {
  /** Flow's update: the old card named a panel tab and a Settings page. */
  const FLOW_PLACES = {
    'right-panel': true,
    'settings.tabs': true,
    pages: true,
    'status-bar': true,
    'command-palette.items': true,
    dialog: true,
  };
  const declaring = (
    contributions: Record<string, boolean>,
    extra: Partial<ExtensionManifest> = {}
  ): ExtensionDeclaringCopy =>
    installed({
      manifest: {
        id: 'ledger',
        name: 'Ledger',
        version: '1.1.0',
        contributions,
        ...extra,
      } as ExtensionManifest,
    });
  const recorded = (slots: string[], set: object = {}): ExtensionApprovals =>
    oldApproval({
      approvedPermissions: {
        ledger: { runtime: 'in-process', net: [], run: [], agents: false, slots, ...set },
      },
    });

  // Purpose: a places-only diff keeps the app running with only its old places.
  it.each([
    ['an approval that recorded its places', recorded(['right-panel', 'settings.tabs'])],
    ['an approval from before places were recorded', oldApproval()],
  ])('keeps Flow running with its old places under %s', (_what, approvals) => {
    const flow = declaring(FLOW_PLACES);
    expect(mayRunExtensionCode(flow, approvals)).toBe(true);
    expect(allowedPlacesOf(flow, approvals)).toEqual(['right-panel', 'settings.tabs']);
    expect(waitingPlacesOf(flow, approvals)).toEqual([
      'pages',
      'status-bar',
      'command-palette.items',
      'dialog',
    ]);
  });

  // Purpose: an unapproved place, the Inbox included, is never allowed.
  it('never allows the Inbox or the canvas the approval did not name', () => {
    const copy = declaring({ 'right-panel': true, inbox: true, canvas: true });
    const approvals = recorded(['right-panel']);
    expect(allowedPlacesOf(copy, approvals)).toEqual(['right-panel']);
    expect(waitingPlacesOf(copy, approvals)).toEqual(['canvas', 'inbox']);
  });

  // Purpose: allowing stores exactly what was shown, so nothing waits after.
  it('allows every place once the stored yes names them', () => {
    const flow = declaring(FLOW_PLACES);
    const approvals = recorded(Object.keys(FLOW_PLACES).sort());
    expect(allowedPlacesOf(flow, approvals)).toEqual([
      'pages',
      'right-panel',
      'settings.tabs',
      'status-bar',
      'command-palette.items',
      'dialog',
    ]);
    expect(waitingPlacesOf(flow, approvals)).toEqual([]);
  });

  // Purpose: any power or host diff pauses the whole app, places or not.
  it.each([
    [
      'a new host',
      recorded(['right-panel'], { runtime: 'subprocess', net: ['a.example.com'] }),
      { serverCapabilities: { runtime: 'subprocess', allow: { net: ['b.example.com'] } } },
    ],
    [
      'a new program',
      recorded(['right-panel'], { runtime: 'subprocess' }),
      { serverCapabilities: { runtime: 'subprocess', allow: { run: ['git'] } } },
    ],
    [
      'agent access',
      recorded(['right-panel'], { runtime: 'subprocess' }),
      { serverCapabilities: { runtime: 'subprocess', allow: { agents: true } } },
    ],
    [
      'moving back inside DorkOS',
      recorded(['right-panel'], { runtime: 'subprocess' }),
      { serverCapabilities: { runtime: 'in-process' } },
    ],
    [
      'an app it calls',
      recorded(['right-panel']),
      { capabilities: { http: { apps: ['planner'] } } },
    ],
  ])('stops the whole app for %s', (_what, approvals, extra) => {
    const variants: Record<string, boolean>[] = [
      { 'right-panel': true },
      { 'right-panel': true, pages: true },
    ];
    for (const places of variants) {
      const copy = declaring(places, extra as Partial<ExtensionManifest>);
      expect(mayRunExtensionCode(copy, approvals)).toBe(false);
      expect(allowedPlacesOf(copy, approvals)).toEqual([]);
      expect(waitingPlacesOf(copy, approvals)).toEqual([]);
    }
  });

  // Purpose: option C never weakens the content pin: changed files still
  // stop the whole app, places-only or not.
  it('still stops the whole app when its files changed', () => {
    const edited = { ...declaring(FLOW_PLACES), currentDigest: `sha256:${'d'.repeat(64)}` };
    const approvals = recorded(['right-panel', 'settings.tabs']);
    expect(mayRunExtensionCode(edited, approvals)).toBe(false);
    expect(allowedPlacesOf(edited, approvals)).toEqual([]);
  });

  // Purpose: DorkOS's own apps and a trusted source show where they declare.
  it('allows every declared place for a core app or a trusted source', () => {
    const flow = declaring(FLOW_PLACES);
    const declared = [
      'pages',
      'right-panel',
      'settings.tabs',
      'status-bar',
      'command-palette.items',
      'dialog',
    ];
    expect(allowedPlacesOf({ ...flow, origin: 'core' }, { approvedToRun: [] })).toEqual(declared);
    expect(
      allowedPlacesOf(flow, {
        approvedToRun: [],
        trustedSources: [{ source: 'dork-labs/marketplace' }],
      } as unknown as ExtensionApprovals)
    ).toEqual(declared);
  });

  // Purpose: an app that may not run shows nowhere.
  it('allows nothing for an app nobody approved', () => {
    expect(allowedPlacesOf(declaring(FLOW_PLACES), { approvedToRun: [] })).toEqual([]);
  });
});
