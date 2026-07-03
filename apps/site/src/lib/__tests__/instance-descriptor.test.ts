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
});
