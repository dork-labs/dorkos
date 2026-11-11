/**
 * `grantsDigestOf` covers `serverCapabilities.connections` (DOR-3547, Security
 * N1): a path-trust copy that starts reading a new service, or a new
 * operation, no longer matches the digest a person approved, so it loses path
 * trust and waits for a person. A manifest that declares none keeps exactly
 * the digest it had before, so no existing approval asks again on upgrade.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { grantsDigestOf } from '../extension-path-trust.js';

type Manifest = ExtensionRecord['manifest'];

const base = {
  id: 'flow-owner',
  name: 'Flow',
  version: '0.2.0',
  serverCapabilities: {
    serverEntry: './server.ts',
    runtime: 'subprocess',
    allow: { net: ['api.github.com'], run: [], agents: false },
  },
} as unknown as Manifest;

const withConnections = (operations: string[]): Manifest =>
  ({
    ...base,
    serverCapabilities: {
      ...base.serverCapabilities,
      connections: [{ service: 'linear', access: 'read', operations }],
    },
  }) as unknown as Manifest;

describe('grantsDigestOf and connections', () => {
  it('keeps the digest a manifest without connections had before', () => {
    // The object the digest hashed before connections existed.
    const before = {
      runtime: 'subprocess',
      net: ['api.github.com'],
      run: [],
      agents: false,
      secrets: [],
      serverEntry: './server.ts',
      dataProxy: null,
      tools: [],
    };
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(before)).digest('hex')}`;
    expect(grantsDigestOf(base)).toBe(expected);
  });

  it('changes when a service or an operation is added', () => {
    const one = grantsDigestOf(withConnections(['LINEAR_LIST_LINEAR_PROJECTS']));
    const two = grantsDigestOf(
      withConnections(['LINEAR_LIST_LINEAR_PROJECTS', 'LINEAR_GET_LINEAR_PROJECT'])
    );
    expect(one).not.toBe(grantsDigestOf(base));
    expect(two).not.toBe(one);
  });
});
