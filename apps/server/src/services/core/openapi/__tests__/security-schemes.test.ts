import { describe, it, expect } from 'vitest';
import { generateOpenAPISpec } from '../../openapi-registry.js';
import { decideSessionGate } from '../../auth/session-gate.js';
import { isGateExemptPath } from '../../auth/gated-paths.js';
import { programKeyOperationKeys } from '../../../connectors/principal/program-key-routes.js';
import { operationSecurity, samplePath } from '../security-schemes.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** Every documented operation, with the `security` the document gives it. */
function documentedOperations() {
  const spec = generateOpenAPISpec();
  const operations: Array<{ method: string; path: string; security: unknown }> = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (op) operations.push({ method: method.toUpperCase(), path, security: op.security });
    }
  }
  return { spec, operations };
}

/** A request from another device, with no credential: the gate must ask for one. */
const fromAnotherDevice = {
  headers: {},
  peerAddress: '203.0.113.7',
  ingress: 'direct' as const,
};

describe('operation security', () => {
  it('declares only the sign-in cookie and a personal API key, and defaults to either', () => {
    const { spec } = documentedOperations();
    expect(Object.keys(spec.components?.securitySchemes ?? {}).sort()).toEqual([
      'apiKey',
      'sessionCookie',
    ]);
    expect(spec.security).toEqual([{ sessionCookie: [] }, { apiKey: [] }]);
  });

  // The real gate, on a person's computer, asked about a credential-less call
  // from another device: whatever it lets through must be documented as open
  // (or as Better Auth's own cookie), and whatever it refuses must not be.
  it('marks open exactly the operations the session gate lets through', async () => {
    const { operations } = documentedOperations();
    const wrong: string[] = [];
    for (const { method, path, security } of operations) {
      const decision = await decideSessionGate(
        method,
        samplePath(path),
        fromAnotherDevice,
        'credential'
      );
      // A hub's link path is open only on a hub, which this test server is not.
      const hubOnly = isGateExemptPath(path, samplePath(path), 'hub') && !decision.allowed;
      const open = decision.allowed || hubOnly;
      const documentedOpen = Array.isArray(security) && security.length === 0;
      const betterAuth = path.startsWith('/api/auth/');
      if (open && !betterAuth && !documentedOpen)
        wrong.push(`${method} ${path}: gate lets it through`);
      if (!open && documentedOpen) wrong.push(`${method} ${path}: gate asks for a credential`);
      if (betterAuth && JSON.stringify(security) !== '[{"sessionCookie":[]}]')
        wrong.push(`${method} ${path}: Better Auth reads its cookie`);
    }
    expect(wrong).toEqual([]);
    const open = operations.filter((op) => Array.isArray(op.security) && !op.security.length);
    expect(open.map((op) => `${op.method} ${op.path}`)).toEqual(
      expect.arrayContaining(['GET /api/health', 'GET /api/extensions/media/{ticket}'])
    );
    expect(open.map((op) => op.path)).not.toContain('/api/health/deep');
  });

  it('marks API-key only every connector route that registers from the program-key list', () => {
    const { operations } = documentedOperations();
    const keyOnly = operations
      .filter((op) => JSON.stringify(op.security) === '[{"apiKey":[]}]')
      .map((op) => `${op.method} ${op.path}`)
      .sort();
    expect(keyOnly).toEqual([...programKeyOperationKeys()].sort());
  });

  it('leaves the default on an ordinary operation', () => {
    expect(operationSecurity('GET', '/api/sessions')).toBeUndefined();
    expect(operationSecurity('GET', '/api/connectors/usage/operator')).toBeUndefined();
  });
});
