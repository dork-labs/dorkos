/**
 * The coverage relation an approval is held to (DOR-2686 task 1.3, D6): a
 * declared permission set runs on an approval only when it asks for nothing
 * the approved set did not allow. Narrowing is covered and never asks again;
 * every way of widening is not covered and waits for a person.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import {
  addedSince,
  addsOnlyPlaces,
  cardTextAddsAPage,
  isCoveredApartFromPlaces,
  declaredSet,
  isCovered,
  isSamePermissionSet,
  type ApprovedPermissionSet,
} from '../permission-coverage.js';
import {
  isApprovedCopy,
  isWithinApprovedPermissions,
  mayRunExtensionCode,
} from '../../extension-load-policy.js';
import { isPendingApproval } from '../../extension-approval-queue.js';
import { isExpectedCopy } from '../../pin/extension-expected-copy.js';

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: () => ({}), set: () => undefined },
}));

/** A subprocess set. */
function sub(net: string[] = [], run: string[] = [], agents = false): ApprovedPermissionSet {
  return { runtime: 'subprocess', net, run, agents };
}

const IN_PROCESS: ApprovedPermissionSet = {
  runtime: 'in-process',
  net: [],
  run: [],
  agents: false,
};

describe('isCovered', () => {
  // Purpose: every narrowing keeps running on the approval it already has.
  it.each<[string, ApprovedPermissionSet, ApprovedPermissionSet | undefined]>([
    [
      'identical',
      sub(['api.example.com:443'], ['git'], true),
      sub(['api.example.com:443'], ['git'], true),
    ],
    ['a host dropped', sub(['a.example.com']), sub(['a.example.com', 'b.example.com'])],
    ['a program dropped', sub([], ['git']), sub([], ['git', 'rg'])],
    ['agents dropped', sub(), sub([], [], true)],
    [
      'a port pinned under a port-less approval',
      sub(['api.example.com:443']),
      sub(['api.example.com']),
    ],
    ['a host under an approved wildcard', sub(['mail.example.com:993']), sub(['*.example.com'])],
    ['a narrower wildcard', sub(['*.mail.example.com']), sub(['*.example.com'])],
    [
      'in-process → subprocess, no entry (legacy approval)',
      sub(['x.example.com'], ['git'], true),
      undefined,
    ],
    [
      'in-process → subprocess, in-process entry',
      sub(['x.example.com'], ['git'], true),
      IN_PROCESS,
    ],
    ['in-process, no entry', IN_PROCESS, undefined],
    ['in-process, in-process entry', IN_PROCESS, IN_PROCESS],
  ])('covers %s', (_label, declared, approved) => {
    expect(isCovered(declared, approved)).toBe(true);
    expect(addedSince(declared, approved)).toBeNull();
  });

  // Purpose: every widening is caught, and `addedSince` names exactly what
  // is new so a re-ask card can lead with it.
  it.each<[string, ApprovedPermissionSet, ApprovedPermissionSet, object]>([
    [
      'a new host',
      sub(['a.example.com', 'evil.example.net']),
      sub(['a.example.com']),
      { net: ['evil.example.net'] },
    ],
    [
      'a new port',
      sub(['api.example.com:8443']),
      sub(['api.example.com:443']),
      { net: ['api.example.com:8443'] },
    ],
    [
      'a port dropped (any port now)',
      sub(['api.example.com']),
      sub(['api.example.com:443']),
      { net: ['api.example.com'] },
    ],
    [
      'a wildcard broader than approved',
      sub(['*.example.com']),
      sub(['*.mail.example.com']),
      { net: ['*.example.com'] },
    ],
    [
      'a wildcard over an approved host',
      sub(['*.api.example.com']),
      sub(['api.example.com']),
      { net: ['*.api.example.com'] },
    ],
    [
      'the apex under an approved wildcard',
      sub(['example.com']),
      sub(['*.example.com']),
      { net: ['example.com'] },
    ],
    ['a new program', sub([], ['git', 'bash']), sub([], ['git']), { run: ['bash'] }],
    [
      'a program by another spelling',
      sub([], ['/usr/bin/git']),
      sub([], ['git']),
      { run: ['/usr/bin/git'] },
    ],
    ['a program by another case', sub([], ['Git']), sub([], ['git']), { run: ['Git'] }],
    ['agents false → true', sub([], [], true), sub(), { agents: true }],
    ['subprocess → in-process', IN_PROCESS, sub(['a.example.com']), { runtime: true }],
  ])('does not cover %s', (_label, declared, approved, added) => {
    expect(isCovered(declared, approved)).toBe(false);
    expect(addedSince(declared, approved)).toEqual({
      net: [],
      run: [],
      agents: false,
      runtime: false,
      ...added,
    });
  });

  // Purpose: an approved entry that does not parse (a hand-edited config)
  // allows nothing, and a declared entry that does not parse is never covered.
  it('fails closed on entries that do not parse', () => {
    expect(isCovered(sub(['api.example.com']), sub(['*']))).toBe(false);
    expect(isCovered(sub(['https://api.example.com']), sub(['api.example.com']))).toBe(false);
  });
});

describe('declared places (DOR-4282)', () => {
  /** A manifest declaring these places. */
  const declaring = (contributions: Record<string, boolean>): ExtensionManifest =>
    ({ id: 'x', name: 'X', version: '1.0.0', contributions }) as ExtensionManifest;

  // Purpose: the set records every declared place, sorted, unknown keys out.
  it('records declared places, sorted', () => {
    expect(
      declaredSet(declaring({ pages: true, dialog: true, 'made-up': true, inbox: false })).slots
    ).toEqual(['dialog', 'pages']);
  });

  // Purpose: a newly declared place asks again, under any runtime.
  it('asks again for a place the approval did not cover', () => {
    const approved = { ...IN_PROCESS, slots: ['settings.tabs'] };
    const next = declaredSet(declaring({ 'settings.tabs': true, 'command-palette.items': true }));
    expect(isCovered(next, approved)).toBe(false);
    expect(addedSince(next, approved)).toEqual({
      net: [],
      run: [],
      agents: false,
      runtime: false,
      slots: ['command-palette.items'],
    });
    expect(addedSince(next, { ...sub(), slots: ['settings.tabs'] })?.slots).toEqual([
      'command-palette.items',
    ]);
  });

  // Purpose: dropping a place never asks.
  it('covers fewer places', () => {
    const approved = { ...IN_PROCESS, slots: ['dialog', 'pages'] };
    expect(isCovered(declaredSet(declaring({ pages: true })), approved)).toBe(true);
  });

  // Purpose: an approval from before places were recorded covers only the
  // two its card named, never everything.
  it('reads an approval without places as the panel tab and Settings page only', () => {
    const legacy = declaredSet(declaring({ 'right-panel': true, 'settings.tabs': true }));
    expect(isCovered(legacy, IN_PROCESS)).toBe(true);
    expect(isCovered(legacy, undefined)).toBe(true);
    const wider = declaredSet(declaring({ 'right-panel': true, pages: true }));
    expect(addedSince(wider, IN_PROCESS)?.slots).toEqual(['pages']);
    expect(addedSince(wider, undefined)?.slots).toEqual(['pages']);
  });

  // Purpose: a stored set without places is written again on the next yes.
  it('is not the same set as one without places', () => {
    expect(isSamePermissionSet({ ...IN_PROCESS, slots: [] }, IN_PROCESS)).toBe(false);
    expect(
      isSamePermissionSet(
        { ...IN_PROCESS, slots: ['a', 'b'] },
        { ...IN_PROCESS, slots: ['b', 'a'] }
      )
    ).toBe(true);
  });
});

describe('new places alone never stop an app (DOR-4282, option C)', () => {
  const declaring = (contributions: Record<string, boolean>): ExtensionManifest =>
    ({ id: 'x', name: 'X', version: '1.0.0', contributions }) as ExtensionManifest;

  // Purpose: places-only is decided from the stored record and the manifest,
  // and only when places are the one thing that is new.
  it('runs when new places are the only addition', () => {
    const next = declaredSet(declaring({ 'settings.tabs': true, pages: true, dialog: true }));
    const approved = { ...IN_PROCESS, slots: ['settings.tabs'] };
    expect(isCovered(next, approved)).toBe(false);
    expect(isCoveredApartFromPlaces(next, approved)).toBe(true);
    expect(isCoveredApartFromPlaces(next, undefined)).toBe(true);
  });

  // Purpose: any power, host, runtime or app diff still stops the whole app.
  it('never counts a power as a place', () => {
    const none = { net: [], run: [], agents: false, runtime: false };
    expect(addsOnlyPlaces({ ...none, slots: ['pages'] })).toBe(true);
    for (const extra of [
      { net: ['a.example.com'] },
      { run: ['git'] },
      { agents: true },
      { runtime: true },
      { apps: ['planner'] },
    ]) {
      expect(addsOnlyPlaces({ ...none, slots: ['pages'], ...extra })).toBe(false);
    }
    expect(addsOnlyPlaces({ ...none })).toBe(false);
    expect(addsOnlyPlaces({ ...none, slots: [] })).toBe(false);
  });

  // Purpose: fail-closed, so a field added to the additions later stops the app.
  it('reads any other field that is not empty as more than places', () => {
    const later = { net: [], run: [], agents: false, runtime: false, slots: ['pages'], hosts: 1 };
    expect(addsOnlyPlaces(later as never)).toBe(false);
  });

  // Purpose: a new host beside a new place stops the app.
  it('stops for a new host beside a new place', () => {
    const approved = { ...sub(['a.example.com']), slots: [] };
    const next = {
      ...sub(['a.example.com', 'b.example.com']),
      slots: ['pages'],
    };
    expect(isCoveredApartFromPlaces(next, approved)).toBe(false);
  });
});

describe('a page on an old card (DOR-4282)', () => {
  /** A manifest declaring these places. */
  const declaring = (contributions: Record<string, boolean>): ExtensionManifest =>
    ({ id: 'x', name: 'X', version: '1.0.0', contributions }) as ExtensionManifest;
  const pages = declaredSet(declaring({ pages: true }));

  // Purpose: stored card text saying "adds a page" covers pages; without it, pages asks.
  it('covers pages only when card text saved with the yes says it adds a page', () => {
    expect(isCovered(pages, IN_PROCESS, 'This adds a page that tracks spending.')).toBe(true);
    expect(isCovered(pages, undefined, 'It adds a page and a Ledger tab.')).toBe(true);
    expect(addedSince(pages, IN_PROCESS)?.slots).toEqual(['pages']);
    expect(addedSince(pages, IN_PROCESS, 'This adds a Ledger tab.')?.slots).toEqual(['pages']);
  });

  // Purpose: only the text saved at the yes counts. The coverage check never
  // reads the manifest's words, so an update that adds page wording to its
  // description gains nothing.
  it('grants nothing to page wording an update puts in its manifest', () => {
    const updated = declaredSet({
      ...declaring({ pages: true }),
      description: 'This adds a page.',
      purpose: 'adds a page',
    } as ExtensionManifest);
    expect(isCovered(updated, IN_PROCESS)).toBe(false);
    expect(isCovered(updated, undefined)).toBe(false);
  });

  // Purpose: an approval that records places never reads text.
  it('ignores card text for an approval that records places', () => {
    expect(isCovered(pages, { ...IN_PROCESS, slots: [] }, 'This adds a page.')).toBe(false);
    expect(isCovered(pages, { ...IN_PROCESS, slots: ['pages'] })).toBe(true);
  });

  // Purpose: a negative or loose phrase never matches.
  it('reads negative and loose phrasing as no', () => {
    for (const text of [
      'This adds no page.',
      "It doesn't add a page.",
      'This doesn’t add a page.',
      'This never adds a page.',
      'This adds a page? Not really.',
      'This adds a Ledger settings page.',
      'A page for your budget.',
      'page',
      'Adds a page.',
      'This adds a page-turner.',
      '',
    ]) {
      expect(cardTextAddsAPage(text), text).toBe(false);
    }
    expect(cardTextAddsAPage('Tracks money. This adds a page, and a tab.')).toBe(true);
  });

  // Purpose: the page is the only place card text can cover; ⌘K, dialogs
  // and the status bar for the same app still ask once.
  it('still asks for ⌘K, a dialog or the status bar', () => {
    const text = 'This adds a page and ⌘K commands and dialogs and a status bar item.';
    for (const key of ['command-palette.items', 'dialog', 'status-bar']) {
      const declared = declaredSet(declaring({ pages: true, [key]: true }));
      expect(addedSince(declared, IN_PROCESS, text)?.slots).toEqual([key]);
    }
  });
});

describe('declaredSet', () => {
  /** A manifest with these server capabilities. */
  const manifest = (serverCapabilities?: object): ExtensionManifest =>
    ({ id: 'x', name: 'X', version: '1.0.0', serverCapabilities }) as ExtensionManifest;

  // Purpose: an extension with no runtime, or in-process, declares full access.
  it('is the in-process set for an in-process extension', () => {
    // `slots` is always recorded, even empty (DOR-4282).
    const declared = { ...IN_PROCESS, slots: [] };
    expect(declaredSet(manifest())).toEqual(declared);
    expect(declaredSet(manifest({ serverEntry: './server.ts' }))).toEqual(declared);
    expect(declaredSet(manifest({ runtime: 'in-process' }))).toEqual(declared);
  });

  // Purpose: a subprocess extension declares exactly its allow lists.
  it('copies the allow lists of a subprocess extension', () => {
    expect(
      declaredSet(
        manifest({
          runtime: 'subprocess',
          allow: { net: ['a.example.com'], run: ['git'], agents: true },
        })
      )
    ).toEqual({ ...sub(['a.example.com'], ['git'], true), slots: [] });
    expect(declaredSet(manifest({ runtime: 'subprocess' }))).toEqual({ ...sub(), slots: [] });
  });

  // Purpose: set equality ignores order but nothing else.
  it('compares sets regardless of order', () => {
    expect(isSamePermissionSet(sub(['a.x.com', 'b.x.com']), sub(['b.x.com', 'a.x.com']))).toBe(
      true
    );
    expect(isSamePermissionSet(sub(['a.x.com']), sub(['a.x.com'], [], true))).toBe(false);
    expect(isSamePermissionSet(sub(), undefined)).toBe(false);
  });
});

describe('the load gate and the approval queue', () => {
  const PATH = '/home/.dork/extensions/mail-app';
  /** The files the approval names, and every record below holds (DOR-3068). */
  const DIGEST = `sha256:${'d'.repeat(64)}`;
  /** A discovered record declaring this set. */
  function record(allow: object): ExtensionRecord {
    return {
      id: 'mail-app',
      manifest: {
        id: 'mail-app',
        name: 'Mail',
        version: '1.0.0',
        serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess', allow },
      } as ExtensionManifest,
      status: 'enabled',
      scope: 'global',
      origin: 'user',
      path: PATH,
      bundleReady: false,
      hasServerEntry: true,
      hasDataProxy: false,
      currentDigest: DIGEST,
    };
  }
  const approvals = {
    approvedToRun: ['mail-app'],
    approvedSources: { 'mail-app': { path: PATH, digest: DIGEST } },
    approvedPermissions: { 'mail-app': sub(['imap.example.com:993']) },
  };

  // Purpose: the copy is still approved, but a widened manifest may not run,
  // and so the approval queue lists it — it keys on mayRunExtensionCode.
  it('stops a copy whose manifest widened and puts it in the queue', () => {
    const widened = record({ net: ['imap.example.com:993', 'exfil.example.net'] });
    expect(isApprovedCopy(widened, approvals)).toBe(true);
    expect(isWithinApprovedPermissions(widened, approvals)).toBe(false);
    expect(mayRunExtensionCode(widened, approvals)).toBe(false);
    expect(isPendingApproval(widened, approvals)).toBe(true);
  });

  // Purpose: the identical or a narrower manifest runs without asking.
  it('lets the identical and a narrower manifest run', () => {
    expect(mayRunExtensionCode(record({ net: ['imap.example.com:993'] }), approvals)).toBe(true);
    expect(mayRunExtensionCode(record({}), approvals)).toBe(true);
    expect(isPendingApproval(record({}), approvals)).toBe(false);
  });

  // Purpose: pin the fail-open edge so it is a known property, not a
  // surprise. A missing map reads as full access (every pre-DOR-2686
  // approval), so a writer that rebuilds `extensions` without spreading the
  // stored object drops it and lets a widened copy run. Writers must spread.
  // If this ever goes red because absence became "nothing", update the
  // migration story with it.
  it('reads a dropped approvedPermissions map as full access', () => {
    const widened = record({ net: ['imap.example.com:993', 'exfil.example.net'] });
    const { approvedPermissions: _dropped, ...withoutMap } = approvals;
    expect(mayRunExtensionCode(widened, withoutMap)).toBe(true);
    expect(mayRunExtensionCode(widened, approvals)).toBe(false);
  });

  // Purpose: a set alone never approves a copy; the copy binding still decides.
  it('never runs on a permission set without an approved copy', () => {
    expect(
      mayRunExtensionCode(record({}), {
        ...approvals,
        approvedSources: { 'mail-app': { path: '/x' } },
      })
    ).toBe(false);
  });

  // Purpose: a stale card — one that showed a different set — is refused,
  // while one that showed exactly the declared set (in any order) is not.
  it('treats a card that showed another permission set as out of date', () => {
    const current = record({ net: ['a.example.com', 'b.example.com'] });
    expect(
      isExpectedCopy(current, {
        version: '1.0.0',
        permissions: sub(['b.example.com', 'a.example.com']),
      })
    ).toBe(true);
    expect(isExpectedCopy(current, { version: '1.0.0', permissions: sub(['a.example.com']) })).toBe(
      false
    );
    expect(isExpectedCopy(current, { version: '1.0.0' })).toBe(true);
  });
});
