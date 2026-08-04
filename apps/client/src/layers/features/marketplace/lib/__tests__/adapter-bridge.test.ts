import { describe, it, expect } from 'vitest';
import { CONNECTOR_ADAPTER_TYPE } from '@dorkos/marketplace';
import { adapterBridge } from '../adapter-bridge';

describe('adapterBridge', () => {
  it('routes a messaging adapter to the Messaging region', () => {
    expect(adapterBridge('adapter', 'telegram')).toEqual({
      line: 'Adds a new way to reach your agents',
      region: 'messaging',
    });
  });

  it('routes a connector-refinement adapter to the Accounts region', () => {
    expect(adapterBridge('adapter', CONNECTOR_ADAPTER_TYPE)).toEqual({
      line: 'Adds a new service your agents can act on',
      region: 'accounts',
    });
  });

  it('treats an adapter with no adapterType as messaging', () => {
    expect(adapterBridge('adapter', undefined)?.region).toBe('messaging');
  });

  it('returns null for every non-adapter package type', () => {
    expect(adapterBridge('agent', undefined)).toBeNull();
    expect(adapterBridge('plugin', undefined)).toBeNull();
    expect(adapterBridge('skill-pack', undefined)).toBeNull();
    expect(adapterBridge('shape', undefined)).toBeNull();
    expect(adapterBridge(undefined, undefined)).toBeNull();
  });
});
