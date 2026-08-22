/**
 * The cwd -> Mesh agent id lookup notification emitters read (DOR-1408).
 *
 * @module services/mesh/__tests__/agent-path-lookup
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveAgentIdForPath,
  resetAgentPathLookup,
  setAgentPathLookup,
} from '../agent-path-lookup.js';

afterEach(() => {
  resetAgentPathLookup();
});

describe('resolveAgentIdForPath', () => {
  it('resolves the id of the agent registered at that directory', () => {
    setAgentPathLookup({
      getByPath: (p) => (p === '/Users/dev/acme' ? { id: 'agent-acme' } : undefined),
    });

    expect(resolveAgentIdForPath('/Users/dev/acme')).toBe('agent-acme');
  });

  it('returns undefined for a directory with no registered agent', () => {
    setAgentPathLookup({ getByPath: () => undefined });

    expect(resolveAgentIdForPath('/Users/dev/nowhere')).toBeUndefined();
  });

  it('returns undefined when no cwd is given', () => {
    setAgentPathLookup({
      getByPath: (p) => (p === '/Users/dev/acme' ? { id: 'agent-acme' } : undefined),
    });

    expect(resolveAgentIdForPath(undefined)).toBeUndefined();
  });

  it('returns undefined before anything has wired a lookup in', () => {
    // No setAgentPathLookup call this test — the boot-order gap a session
    // event racing MeshCore's own init would hit.
    expect(resolveAgentIdForPath('/Users/dev/acme')).toBeUndefined();
  });

  it('degrades to undefined rather than throwing when the lookup itself throws', () => {
    setAgentPathLookup({
      getByPath: () => {
        throw new Error('registry unavailable');
      },
    });

    expect(() => resolveAgentIdForPath('/Users/dev/acme')).not.toThrow();
    expect(resolveAgentIdForPath('/Users/dev/acme')).toBeUndefined();
  });
});
