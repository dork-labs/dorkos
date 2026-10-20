import { describe, expect, it } from 'vitest';
import { compositionRootSource } from './composition-root.js';

const source = compositionRootSource();

describe('connector agent cleanup startup wiring', () => {
  it('registers the cleanup callback before startup reconciliation can remove an agent', () => {
    const constructRegistry = source.indexOf('const connectorRegistry = new ConnectorRegistry');
    const constructMesh = source.indexOf('meshCore = new MeshCore');
    const registerCleanup = source.indexOf('registerConnectorAgentCleanup({');
    const reconcile = source.indexOf('await refs.meshCore.reconcileOnStartup()');

    expect(constructRegistry).toBeGreaterThan(-1);
    expect(constructMesh).toBeGreaterThan(constructRegistry);
    expect(registerCleanup).toBeGreaterThan(constructMesh);
    expect(reconcile).toBeGreaterThan(registerCleanup);
  });
});
