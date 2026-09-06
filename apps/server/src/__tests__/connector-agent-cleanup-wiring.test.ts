import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('connector agent cleanup startup wiring', () => {
  it('registers the cleanup callback before startup reconciliation can remove an agent', () => {
    const constructRegistry = source.indexOf('const connectorRegistry = new ConnectorRegistry');
    const constructMesh = source.indexOf('meshCore = new MeshCore');
    const registerCleanup = source.indexOf('registerConnectorAgentCleanup({');
    const reconcile = source.indexOf('await meshCore.reconcileOnStartup()');

    expect(constructRegistry).toBeGreaterThan(-1);
    expect(constructMesh).toBeGreaterThan(constructRegistry);
    expect(registerCleanup).toBeGreaterThan(constructMesh);
    expect(reconcile).toBeGreaterThan(registerCleanup);
  });
});
