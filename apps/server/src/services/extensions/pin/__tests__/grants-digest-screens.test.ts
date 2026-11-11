/**
 * `grantsDigestOf` covers what an app's screens can reach (DOR-3293, Security):
 * the bridge writes a manifest has to declare (`capabilities.rooms`,
 * `capabilities.forward`), the other apps it calls (`capabilities.http.apps`)
 * and the routes it lets other apps call (`exports`). A path-trust copy that
 * adds any of them no longer matches the digest a person approved, so it asks
 * again. A manifest that declares none keeps exactly the digest it had before,
 * so no existing approval asks again on upgrade.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { grantsDigestOf, keepsPathTrust } from '../extension-path-trust.js';

type Manifest = ExtensionRecord['manifest'];

const HOME = '/agents/desk-maker';

const base = {
  id: 'desk',
  name: 'Desk',
  version: '1.0.0',
  clientApiVersion: 2,
  serverCapabilities: {
    serverEntry: './server.ts',
    runtime: 'subprocess',
    allow: { net: [], run: [], agents: false },
  },
} as unknown as Manifest;

const withFields = (fields: Record<string, unknown>): Manifest =>
  ({ ...base, ...fields }) as unknown as Manifest;

describe('grantsDigestOf and what screens reach', () => {
  it('keeps the digest a manifest without these fields had before', () => {
    // The object the digest hashed before these fields existed.
    const before = {
      runtime: 'subprocess',
      net: [],
      run: [],
      agents: false,
      secrets: [],
      serverEntry: './server.ts',
      dataProxy: null,
      tools: [],
    };
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(before)).digest('hex')}`;
    expect(grantsDigestOf(base)).toBe(expected);
    // Declaring the http capability without other apps changes nothing either.
    expect(grantsDigestOf(withFields({ capabilities: { http: true } }))).toBe(expected);
  });

  it.each([
    ['a room-thread reply write', { capabilities: { rooms: true } }],
    ['a forward write', { capabilities: { forward: true } }],
    ['another app it calls', { capabilities: { http: { apps: ['ledger'] } } }],
    [
      'a route it lets other apps call',
      { exports: { http: [{ path: '/items', methods: ['GET'] }] } },
    ],
  ])('changes when it adds %s', (_what, fields) => {
    expect(grantsDigestOf(withFields(fields))).not.toBe(grantsDigestOf(base));
  });

  it('changes again when a second app or a wider export is added', () => {
    const one = grantsDigestOf(withFields({ capabilities: { http: { apps: ['ledger'] } } }));
    const two = grantsDigestOf(
      withFields({ capabilities: { http: { apps: ['ledger', 'mkt-core'] } } })
    );
    expect(two).not.toBe(one);
    const read = grantsDigestOf(
      withFields({ exports: { http: [{ path: '/items', methods: ['GET'] }] } })
    );
    const write = grantsDigestOf(
      withFields({ exports: { http: [{ path: '/items', methods: ['GET', 'POST'] }] } })
    );
    expect(write).not.toBe(read);
  });

  it('makes a path-trusted app ask again when it adds a write', () => {
    const copy = {
      manifest: base,
      scope: 'local' as const,
      realPath: `${HOME}/.dork/extensions/desk`,
    };
    const source = {
      path: copy.realPath,
      authorHome: HOME,
      grants: grantsDigestOf(base),
    } as ExtensionApprovedSource;
    expect(keepsPathTrust(copy, source)).toBe(true);
    const widened = { ...copy, manifest: withFields({ capabilities: { rooms: true } }) };
    expect(keepsPathTrust(widened, source)).toBe(false);
  });
});
