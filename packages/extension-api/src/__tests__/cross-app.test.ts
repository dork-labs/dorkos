import { describe, expect, it } from 'vitest';
import {
  decideAppCall,
  exportedAccess,
  routeMatches,
  type CrossAppManifest,
} from '../cross-app.js';
import { ExtensionManifestSchema } from '../manifest-schema.js';

const reports: CrossAppManifest = {
  id: 'reports',
  capabilities: { http: { apps: ['ledger'] } },
};
const ledger: CrossAppManifest = {
  id: 'ledger',
  exports: {
    http: [
      { path: '/entries', methods: ['GET'] },
      { path: '/entries/:id', methods: ['GET', 'PATCH'] },
      { path: '/totals', methods: ['GET'], callers: ['budget'] },
    ],
    personOnly: ['/approve'],
  },
};

const call = (
  overrides: Partial<Parameters<typeof decideAppCall>[0]> = {}
): ReturnType<typeof decideAppCall> =>
  decideAppCall({
    caller: reports,
    target: ledger,
    targetId: 'ledger',
    method: 'GET',
    path: '/entries',
    ...overrides,
  });

describe('one app calling another (DOR-3293)', () => {
  it('allows an exported read to an app the caller lists', () => {
    expect(call()).toEqual({ ok: true });
    expect(call({ path: '/entries/e-17?full=1' })).toEqual({ ok: true });
  });

  it('allows a write only where the export lists that method', () => {
    expect(call({ method: 'PATCH', path: '/entries/e-17' })).toEqual({ ok: true });
    expect(call({ method: 'POST', path: '/entries' })).toEqual({
      ok: false,
      reason: 'method-not-exported',
    });
    expect(call({ method: 'DELETE', path: '/entries/e-17' })).toEqual({
      ok: false,
      reason: 'method-not-exported',
    });
  });

  it('refuses a target the caller does not list', () => {
    expect(call({ caller: { id: 'reports', capabilities: { http: true } } })).toEqual({
      ok: false,
      reason: 'not-declared',
    });
  });

  it('works one way only: listing an app gives it nothing back', () => {
    const back = decideAppCall({
      caller: { id: 'ledger', capabilities: { http: true } },
      target: { id: 'reports', exports: { http: [{ path: '/x', methods: ['GET'] }] } },
      targetId: 'reports',
      method: 'GET',
      path: '/x',
    });
    expect(back).toEqual({ ok: false, reason: 'not-declared' });
  });

  it('refuses a route the target does not export', () => {
    expect(call({ path: '/secrets' })).toEqual({ ok: false, reason: 'not-exported' });
    expect(call({ path: '/entries/e-17/history' })).toEqual({ ok: false, reason: 'not-exported' });
    expect(call({ target: { id: 'ledger' } })).toEqual({ ok: false, reason: 'not-exported' });
  });

  it('refuses a personOnly route', () => {
    expect(call({ path: '/approve' })).toEqual({ ok: false, reason: 'person-only' });
  });

  it('refuses a route narrowed to other callers', () => {
    expect(call({ path: '/totals' })).toEqual({ ok: false, reason: 'caller-not-listed' });
  });

  it('refuses a target that is not installed or not running, and itself', () => {
    expect(call({ target: null })).toEqual({ ok: false, reason: 'target-unavailable' });
    expect(call({ targetId: 'reports' })).toEqual({ ok: false, reason: 'self' });
  });

  it('matches a placeholder to exactly one segment', () => {
    expect(routeMatches('/entries/:id', '/entries/e-17')).toBe(true);
    expect(routeMatches('/entries/:id', '/entries/')).toBe(false);
    expect(routeMatches('/entries/:id', '/entries/a/b')).toBe(false);
    expect(routeMatches('/entries', '/entriesx')).toBe(false);
  });

  it('says what a target lets a caller do, from the target’s exports', () => {
    expect(exportedAccess(ledger, 'reports')).toBe('both');
    expect(exportedAccess({ exports: { http: [{ path: '/a', methods: ['GET'] }] } }, 'x')).toBe(
      'reads'
    );
    expect(exportedAccess({}, 'reports')).toBeNull();
  });
});

describe('the manifest fields for it', () => {
  const base = { id: 'ledger', name: 'Ledger', version: '1.0.0' };

  it('takes a list of apps and exported routes', () => {
    const parsed = ExtensionManifestSchema.safeParse({
      ...base,
      capabilities: { http: { apps: ['reports'] } },
      exports: { http: [{ path: '/entries/:id', methods: ['GET'] }], personOnly: ['/approve'] },
    });
    expect(parsed.success).toBe(true);
  });

  it('still takes http: true', () => {
    expect(
      ExtensionManifestSchema.safeParse({ ...base, capabilities: { http: true } }).success
    ).toBe(true);
  });

  it.each([
    [
      'an export over a personOnly route',
      { exports: { http: [{ path: '/approve', methods: ['GET'] }], personOnly: ['/approve'] } },
    ],
    [
      'a placeholder export over a personOnly route',
      { exports: { http: [{ path: '/:any', methods: ['GET'] }], personOnly: ['/approve'] } },
    ],
    ['an app listing itself', { capabilities: { http: { apps: ['ledger'] } } }],
    ['an export with no methods', { exports: { http: [{ path: '/a', methods: [] }] } }],
    ['a wildcard path', { exports: { http: [{ path: '/a/*', methods: ['GET'] }] } }],
    ['a path with dot-dot', { exports: { http: [{ path: '/a/../b', methods: ['GET'] }] } }],
    ['an unknown field', { exports: { http: [{ path: '/a', methods: ['GET'], open: true }] } }],
    ['a bad app id', { capabilities: { http: { apps: ['Not An Id'] } } }],
  ])('refuses %s', (_name, fields) => {
    expect(ExtensionManifestSchema.safeParse({ ...base, ...fields }).success).toBe(false);
  });
});
