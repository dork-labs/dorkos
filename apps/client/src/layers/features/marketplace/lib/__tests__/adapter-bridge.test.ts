import { describe, it, expect } from 'vitest';
import { CONNECTOR_ADAPTER_TYPE } from '@dorkos/marketplace';
import { adapterBridge } from '../adapter-bridge';

describe('adapterBridge', () => {
  it('says a messaging adapter adds a way to reach your agents', () => {
    expect(adapterBridge('adapter', 'telegram')).toEqual({
      line: 'Adds a new way to reach your agents',
    });
  });

  it('says a connector-refinement adapter adds a service agents act on', () => {
    expect(adapterBridge('adapter', CONNECTOR_ADAPTER_TYPE)).toEqual({
      line: 'Adds a new service your agents can act on',
    });
  });

  it('treats an adapter with no adapterType as messaging', () => {
    expect(adapterBridge('adapter', undefined)?.line).toBe('Adds a new way to reach your agents');
  });

  it('returns null for every non-adapter package type', () => {
    expect(adapterBridge('agent', undefined)).toBeNull();
    expect(adapterBridge('plugin', undefined)).toBeNull();
    expect(adapterBridge('skill-pack', undefined)).toBeNull();
    expect(adapterBridge('shape', undefined)).toBeNull();
    expect(adapterBridge(undefined, undefined)).toBeNull();
  });
});
