import { describe, it, expect } from 'vitest';
import { connectorGmailCase } from '../suite/connectors.js';
import { ALL_CASES, selectSuite } from '../suite/index.js';
import type { OracleContext } from '../types.js';

// The W4 connector evals run against the interface with fakes, so their oracles
// ignore the live OracleContext (no server, no model). A minimal stub satisfies
// the type; the assertions come entirely from the in-process contract checks.
const stubCtx: OracleContext = {
  sandbox: { projectCwd: '', dorkHome: '' },
  baseUrl: '',
  sessionId: '',
  frames: [],
};

describe('connector-gmail (W4) — "Connect to my Gmail", expressed against the ConnectorProvider interface', () => {
  it('is registered and tiered like an unverified-live case (connector tag, quarantined)', () => {
    expect(connectorGmailCase.id).toBe('connector-gmail');
    expect(connectorGmailCase.prompt).toBe('');
    expect(connectorGmailCase.tags).toContain('connector');
    expect(connectorGmailCase.quarantined).toBe(true);
    // Registered in the harness suite so `--suite connector` selects it.
    expect(ALL_CASES).toContain(connectorGmailCase);
    expect(selectSuite('connector').map((c) => c.id)).toContain('connector-gmail');
  });

  it.each(connectorGmailCase.oracles.map((oracle, i) => [i, oracle] as const))(
    'oracle %i holds against the interface (fake-backed, no live credentials)',
    async (_i, oracle) => {
      const result = await oracle(stubCtx);
      expect(result.passed, `${result.label}${result.detail ? `: ${result.detail}` : ''}`).toBe(
        true
      );
    }
  );
});
