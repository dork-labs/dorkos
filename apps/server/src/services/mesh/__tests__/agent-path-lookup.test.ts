/**
 * The cwd -> Mesh agent id lookup notification emitters read (DOR-1408).
 *
 * @module services/mesh/__tests__/agent-path-lookup
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  resolveAgentIdForPath,
  resetAgentPathLookup,
  setAgentPathLookup,
} from '../agent-path-lookup.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

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

  it("attributes a managed checkout of the agent's repo to the agent (DOR-2355)", () => {
    registerTestHomes(['/Users/dev/acme'], {
      managed: { '/Users/dev/.dork/workspaces/acme/fix': '/Users/dev/acme' },
    });
    setAgentPathLookup({
      getByPath: (p) => (p === '/Users/dev/acme' ? { id: 'agent-acme' } : undefined),
    });

    expect(resolveAgentIdForPath('/Users/dev/.dork/workspaces/acme/fix')).toBe('agent-acme');
    // Never by prefix: a subfolder of the home is not the agent.
    expect(resolveAgentIdForPath('/Users/dev/acme/src')).toBeUndefined();
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
