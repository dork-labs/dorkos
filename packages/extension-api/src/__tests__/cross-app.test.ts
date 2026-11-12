import { describe, expect, it } from 'vitest';
import {
  decideAppCall,
  decideAppNavigate,
  exportedAccess,
  routeMatches,
  type AppExportRoute,
  type CrossAppManifest,
  type PersonOnlyRule,
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

  it('marks one method person-only and leaves the others on that path exported', () => {
    const core: CrossAppManifest = {
      id: 'ledger',
      exports: {
        http: [{ path: '/approvals', methods: ['GET'] }],
        personOnly: [{ path: '/approvals', methods: ['POST'] }],
      },
    };
    expect(call({ target: core, path: '/approvals' })).toEqual({ ok: true });
    expect(call({ target: core, method: 'POST', path: '/approvals' })).toEqual({
      ok: false,
      reason: 'person-only',
    });
    // A method neither exported nor person-only is simply not exported.
    expect(call({ target: core, method: 'PUT', path: '/approvals' })).toEqual({
      ok: false,
      reason: 'method-not-exported',
    });
  });

  it('a person-only rule with a placeholder covers every path it matches, for its methods only', () => {
    const core: CrossAppManifest = {
      id: 'ledger',
      exports: {
        http: [{ path: '/variants/:id', methods: ['GET'] }],
        personOnly: [{ path: '/variants/:id', methods: ['PATCH', 'DELETE'] }],
      },
    };
    expect(call({ target: core, path: '/variants/v-1' })).toEqual({ ok: true });
    expect(call({ target: core, method: 'DELETE', path: '/variants/v-1' })).toEqual({
      ok: false,
      reason: 'person-only',
    });
  });

  it('counts only the methods a person-only rule leaves exported', () => {
    // Read off a stored record, which the install check never saw.
    const http: AppExportRoute[] = [{ path: '/approvals', methods: ['GET', 'POST'] }];
    const access = (personOnly: PersonOnlyRule[]) =>
      exportedAccess({ exports: { http, personOnly } }, 'reports');
    expect(access([{ path: '/approvals', methods: ['POST'] }])).toBe('reads');
    expect(access([{ path: '/approvals', methods: ['GET'] }])).toBe('changes');
    expect(access(['/approvals'])).toBeNull();
    expect(access([{ path: '/other', methods: ['POST'] }])).toBe('both');
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

describe('one app opening another app’s page (DOR-3293)', () => {
  const open = (
    overrides: Partial<Parameters<typeof decideAppNavigate>[0]> = {}
  ): ReturnType<typeof decideAppNavigate> =>
    decideAppNavigate({
      caller: reports,
      target: ledger,
      targetId: 'ledger',
      itemPath: '/item/entry/e-17',
      ...overrides,
    });

  it('opens a page of an app the caller lists, by its item path alone', () => {
    expect(open()).toEqual({ ok: true });
    expect(open({ itemPath: '' })).toEqual({ ok: true });
    expect(open({ itemPath: '/entries' })).toEqual({ ok: true });
  });

  it('needs no export: listing the app is what lets the caller open its pages', () => {
    expect(open({ target: { id: 'ledger' } })).toEqual({ ok: true });
  });

  it('refuses an app the caller does not list, works one way only, and never itself', () => {
    expect(open({ caller: { id: 'reports', capabilities: { http: true } } })).toEqual({
      ok: false,
      reason: 'not-declared',
    });
    expect(
      decideAppNavigate({
        caller: { id: 'ledger' },
        target: { id: 'reports' },
        targetId: 'reports',
        itemPath: '',
      })
    ).toEqual({ ok: false, reason: 'not-declared' });
    expect(open({ targetId: 'reports' })).toEqual({ ok: false, reason: 'self' });
  });

  it('refuses an app that is not installed or not running', () => {
    expect(open({ target: null })).toEqual({ ok: false, reason: 'target-unavailable' });
  });

  it.each([
    ['a query', '/item/entry/e-17?approve=1'],
    ['an empty query', '/item/entry/e-17?'],
    ['a hash', '/item/entry/e-17#approve'],
    ['an encoded character', '/item/entry/e%2F17'],
    ['a dot-dot segment', '/item/../settings'],
    ['a dot segment', '/item/./entry'],
    ['an empty segment', '/item//entry'],
    ['a trailing slash', '/item/entry/'],
    ['a backslash', '/item\\entry'],
    ['a space', '/item/entry one'],
    ['no leading slash', 'item/entry/e-17'],
    ['too many segments', '/a/b/c/d/e/f/g/h/i'],
    ['a very long path', `/${'a'.repeat(401)}`],
  ])('refuses %s: the link carries only the item', (_name, itemPath) => {
    expect(open({ itemPath })).toEqual({ ok: false, reason: 'not-an-item-path' });
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

  it('takes a person-only rule for some methods beside an export of others on the same path', () => {
    const parsed = ExtensionManifestSchema.safeParse({
      ...base,
      exports: {
        http: [
          { path: '/approvals', methods: ['GET'] },
          { path: '/dial', methods: ['GET'] },
        ],
        personOnly: [
          { path: '/approvals', methods: ['POST'] },
          { path: '/dial', methods: ['PUT'] },
          '/approve',
        ],
      },
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
    [
      'an export whose method a person-only rule on the same path names',
      {
        exports: {
          http: [{ path: '/approvals', methods: ['GET', 'POST'] }],
          personOnly: [{ path: '/approvals', methods: ['POST'] }],
        },
      },
    ],
    [
      'a placeholder export whose method an overlapping person-only rule names',
      {
        exports: {
          http: [{ path: '/:kind/:id', methods: ['PATCH'] }],
          personOnly: [{ path: '/variants/:id', methods: ['PATCH'] }],
        },
      },
    ],
    [
      'a person-only rule with no methods',
      { exports: { personOnly: [{ path: '/approvals', methods: [] }] } },
    ],
    [
      'a person-only rule naming a method twice',
      { exports: { personOnly: [{ path: '/approvals', methods: ['POST', 'POST'] }] } },
    ],
    [
      'a person-only rule with an unknown field',
      { exports: { personOnly: [{ path: '/approvals', methods: ['POST'], all: true }] } },
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
