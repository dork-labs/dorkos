import { describe, expect, it } from 'vitest';

import { encodeInstanceDescriptor, parseInstanceDescriptor } from '../instance-descriptor';

describe('instance descriptor codec', () => {
  it('round-trips a descriptor through the scope field', () => {
    const descriptor = { name: "Kai's MacBook", platform: 'darwin', dorkosVersion: '0.4.2' };
    expect(parseInstanceDescriptor(encodeInstanceDescriptor(descriptor))).toEqual(descriptor);
  });

  it('falls back to honest placeholders for a missing scope', () => {
    expect(parseInstanceDescriptor(null)).toEqual({
      name: 'A DorkOS instance',
      platform: 'unknown',
      dorkosVersion: 'unknown',
    });
  });

  it('falls back for malformed or partial scope values', () => {
    expect(parseInstanceDescriptor('not json').name).toBe('A DorkOS instance');
    const partial = parseInstanceDescriptor(JSON.stringify({ name: 'Box' }));
    expect(partial.name).toBe('Box');
    expect(partial.platform).toBe('unknown');
  });

  it('round-trips an optional telemetry instanceId when present (the merge signal)', () => {
    const descriptor = {
      name: 'Box',
      platform: 'linux',
      dorkosVersion: '0.47.0',
      telemetryInstanceId: 'inst-uuid-7',
    };
    expect(parseInstanceDescriptor(encodeInstanceDescriptor(descriptor))).toEqual(descriptor);
  });

  it('omits telemetryInstanceId entirely when the instance did not send one', () => {
    const descriptor = { name: 'Box', platform: 'linux', dorkosVersion: '0.47.0' };
    const encoded = encodeInstanceDescriptor(descriptor);
    expect(encoded).not.toContain('telemetryInstanceId');
    expect(parseInstanceDescriptor(encoded).telemetryInstanceId).toBeUndefined();
  });
});
