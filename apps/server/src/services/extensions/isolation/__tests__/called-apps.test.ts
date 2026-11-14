/**
 * The other apps an app calls, on its approval and its card (DOR-3293): an
 * update that adds one asks again, removing one does not, and the card names
 * each with DorkOS's words and what that app's own exports share.
 */
import { describe, expect, it } from 'vitest';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import { addedSince, declaredSet, isCovered, isSamePermissionSet } from '../permission-coverage.js';
import { calledAppsView } from '../called-apps.js';

const caller = (apps: string[], runtime?: 'subprocess'): ExtensionManifest =>
  ({
    id: 'reports',
    name: 'Reports',
    version: '1.0.0',
    capabilities: { http: { apps } },
    ...(runtime ? { serverCapabilities: { runtime } } : {}),
  }) as ExtensionManifest;

describe('asking again for a new app to call', () => {
  it('records the apps it calls when approved', () => {
    expect(declaredSet(caller(['ledger', 'desk'])).apps).toEqual(['ledger', 'desk']);
    expect(declaredSet(caller([]))).not.toHaveProperty('apps');
  });

  it('asks again when an update adds an app, naming only the new one', () => {
    const approved = declaredSet(caller(['ledger']));
    const next = declaredSet(caller(['ledger', 'desk']));
    expect(isCovered(next, approved)).toBe(false);
    expect(addedSince(next, approved)).toEqual({
      net: [],
      run: [],
      agents: false,
      runtime: false,
      apps: ['desk'],
    });
  });

  it('asks again even under an approval to run inside DorkOS with full access', () => {
    const approved = { runtime: 'in-process' as const, net: [], run: [], agents: false };
    expect(addedSince(declaredSet(caller(['ledger'])), approved)?.apps).toEqual(['ledger']);
  });

  it('asks again for an approval given before apps were recorded', () => {
    expect(isCovered(declaredSet(caller(['ledger'])), undefined)).toBe(false);
  });

  it('asks again for a separately running app that adds an app', () => {
    const approved = declaredSet(caller([], 'subprocess'));
    expect(addedSince(declaredSet(caller(['ledger'], 'subprocess')), approved)?.apps).toEqual([
      'ledger',
    ]);
  });

  it('does not ask when an update removes an app', () => {
    const approved = declaredSet(caller(['ledger', 'desk']));
    expect(isCovered(declaredSet(caller(['ledger'])), approved)).toBe(true);
  });

  it('counts a different app list as a different set to record', () => {
    expect(
      isSamePermissionSet(declaredSet(caller(['ledger'])), declaredSet(caller(['desk'])))
    ).toBe(false);
    expect(
      isSamePermissionSet(declaredSet(caller(['ledger'])), declaredSet(caller(['ledger'])))
    ).toBe(true);
  });
});

describe('the card’s apps, in DorkOS’s words', () => {
  const record = (manifest: ExtensionManifest, status = 'active') =>
    ({ manifest, status }) as Pick<ExtensionRecord, 'manifest' | 'status'>;
  const others = new Map([
    [
      'ledger',
      record({
        id: 'ledger',
        name: 'Ledger',
        version: '1.0.0',
        exports: { http: [{ path: '/entries', methods: ['GET'] }] },
      }),
    ],
    [
      'desk',
      record({
        id: 'desk',
        name: 'Desk',
        version: '1.0.0',
        exports: { http: [{ path: '/todos', methods: ['GET', 'POST'] }] },
      }),
    ],
    ['quill', record({ id: 'quill', name: 'Quill', version: '1.0.0' }, 'disabled')],
    ['vault', record({ id: 'vault', name: 'Vault', version: '1.0.0' })],
  ]);

  it('names each app and what its own exports share with this one', () => {
    const view = calledAppsView(
      { id: 'reports', manifest: caller(['ledger', 'desk', 'quill', 'gone', 'vault']) },
      (id) => others.get(id)
    );
    expect(view).toEqual([
      { id: 'ledger', name: 'Ledger', access: 'reads' },
      { id: 'desk', name: 'Desk', access: 'both' },
      // Turned off, or not installed at all: no name, nothing shared.
      { id: 'quill', name: null, access: null },
      { id: 'gone', name: null, access: null },
      // Installed, but shares nothing with it.
      { id: 'vault', name: 'Vault', access: null },
    ]);
  });
});

describe('what an app’s screens can change (Security item 8)', () => {
  it('lists what every screen can change, and rooms or forwarding only when declared', async () => {
    const { screenWrites } = await import('../screen-writes.js');
    expect(screenWrites({})).toEqual(['data', 'canvas', 'inbox', 'work', 'files']);
    expect(screenWrites({ capabilities: { rooms: true, forward: true } })).toEqual([
      'data',
      'canvas',
      'inbox',
      'work',
      'files',
      'rooms',
      'forward',
    ]);
  });
});

describe('a target that starts sharing more (designer, 2026-11-10)', () => {
  it('asks again, naming that target as new, like a new target', async () => {
    const { setCalledAppAccessLookup } = await import('../permission-coverage.js');
    const shares = new Map<string, 'reads' | 'changes' | 'both'>();
    setCalledAppAccessLookup((_caller, target) => shares.get(target) ?? null);
    try {
      // Approved while Ledger shared nothing with it.
      const approved = declaredSet(caller(['ledger']));
      expect(approved).not.toHaveProperty('appAccess');

      // Ledger's update starts sharing a route: the app asks again.
      shares.set('ledger', 'reads');
      expect(isCovered(declaredSet(caller(['ledger'])), approved)).toBe(false);
      expect(addedSince(declaredSet(caller(['ledger'])), approved)?.apps).toEqual(['ledger']);

      // Approved again at reads; Ledger then lets it change things too.
      const atReads = declaredSet(caller(['ledger']));
      expect(atReads.appAccess).toEqual({ ledger: 'reads' });
      shares.set('ledger', 'both');
      expect(addedSince(declaredSet(caller(['ledger'])), atReads)?.apps).toEqual(['ledger']);

      // Sharing less never asks.
      const atBoth = declaredSet(caller(['ledger']));
      shares.set('ledger', 'reads');
      expect(isCovered(declaredSet(caller(['ledger'])), atBoth)).toBe(true);
      shares.delete('ledger');
      expect(isCovered(declaredSet(caller(['ledger'])), atBoth)).toBe(true);
    } finally {
      setCalledAppAccessLookup(() => null);
    }
  });

  it('reads what a target shares only while it is on', async () => {
    const { calledAppAccessLookupIn } = await import('../called-apps.js');
    const ledger = {
      manifest: {
        id: 'ledger',
        name: 'Ledger',
        version: '1.0.0',
        exports: { http: [{ path: '/entries', methods: ['GET' as const] }] },
      },
      status: 'active' as ExtensionRecord['status'],
    };
    const lookup = calledAppAccessLookupIn((id) => (id === 'ledger' ? ledger : undefined));
    expect(lookup('reports', 'ledger')).toBe('reads');
    ledger.status = 'disabled';
    expect(lookup('reports', 'ledger')).toBeNull();
    expect(lookup('reports', 'gone')).toBeNull();
  });
});
