import { describe, it, expect } from 'vitest';
import { connectorSlackCase } from '../suite/connectors.js';
import { ALL_CASES, selectSuite } from '../suite/index.js';
import type { OracleContext } from '../types.js';

// Fake-backed routing eval: the oracle ignores the live OracleContext (no
// server, no model) and asserts the recommendConnector precedence contract
// directly against the interface. A minimal stub satisfies the type.
const stubCtx: OracleContext = {
  sandbox: { projectCwd: '', dorkHome: '' },
  baseUrl: '',
  sessionId: '',
  frames: [],
};

describe('connector-slack (W4) — "Connect to Slack" routes to the relay adapter, not the gateway', () => {
  it('is registered and tiered like an unverified-live case (connector tag, quarantined)', () => {
    expect(connectorSlackCase.id).toBe('connector-slack');
    expect(connectorSlackCase.prompt).toBe('');
    expect(connectorSlackCase.tags).toContain('connector');
    expect(connectorSlackCase.quarantined).toBe(true);
    expect(ALL_CASES).toContain(connectorSlackCase);
    expect(selectSuite('connector').map((c) => c.id)).toContain('connector-slack');
  });

  it.each(connectorSlackCase.oracles.map((oracle, i) => [i, oracle] as const))(
    'oracle %i proves relay-adapter-first routing (fake relay catalog + fake gateway)',
    async (_i, oracle) => {
      const result = await oracle(stubCtx);
      expect(result.passed, `${result.label}${result.detail ? `: ${result.detail}` : ''}`).toBe(
        true
      );
    }
  );
});
