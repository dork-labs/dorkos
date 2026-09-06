import { describe, expect, it } from 'vitest';
import {
  createServerPrincipal,
  isServerPrincipal,
  type ServerPrincipalClaims,
} from '../server-principal.js';
import * as connectorService from '../../index.js';

describe('server principal authenticity', () => {
  it('accepts only the exact process-minted proof object', () => {
    const source = {
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-a' },
      bindingId: 'binding-a',
      runtime: 'codex',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      agentPath: '/agents/a',
      canonicalCwd: '/projects/a',
    } satisfies ServerPrincipalClaims;
    const principal = createServerPrincipal(source);

    source.owner.installationId = 'install-b';

    expect(isServerPrincipal(principal)).toBe(true);
    expect(principal.claims.owner).toEqual({
      kind: 'local_install',
      installationId: 'install-a',
    });
    expect(Object.isFrozen(principal.claims.owner)).toBe(true);
    expect(isServerPrincipal({ claims: principal.claims })).toBe(false);
    expect(isServerPrincipal(JSON.parse(JSON.stringify(principal)))).toBe(false);
  });

  it('does not expose the mint through the connector consumer barrel', () => {
    expect('createServerPrincipal' in connectorService).toBe(false);
    expect(connectorService.isServerPrincipal).toBe(isServerPrincipal);
  });
});
