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
import { isExpectedCopy } from '../../extension-manager.js';

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

describe('declaredSet', () => {
  /** A manifest with these server capabilities. */
  const manifest = (serverCapabilities?: object): ExtensionManifest =>
    ({ id: 'x', name: 'X', version: '1.0.0', serverCapabilities }) as ExtensionManifest;

  // Purpose: an extension with no runtime, or in-process, declares full access.
  it('is the in-process set for an in-process extension', () => {
    expect(declaredSet(manifest())).toEqual(IN_PROCESS);
    expect(declaredSet(manifest({ serverEntry: './server.ts' }))).toEqual(IN_PROCESS);
    expect(declaredSet(manifest({ runtime: 'in-process' }))).toEqual(IN_PROCESS);
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
    ).toEqual(sub(['a.example.com'], ['git'], true));
    expect(declaredSet(manifest({ runtime: 'subprocess' }))).toEqual(sub());
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
    };
  }
  const approvals = {
    approvedToRun: ['mail-app'],
    approvedSources: { 'mail-app': { path: PATH } },
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
