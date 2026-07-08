import { describe, it, expect } from 'vitest';
import {
  parseAgentSubject,
  extractSessionIdFromSubject,
  agentSubject,
  runtimeSessionSubject,
  legacyAgentSubject,
  isRuntimeType,
  guardNamespaceCollision,
  RUNTIME_TYPES,
} from '../subjects.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ULID = '01JKABC0000000000000000000';

describe('isRuntimeType', () => {
  it('accepts every closed runtime type', () => {
    for (const t of RUNTIME_TYPES) {
      expect(isRuntimeType(t)).toBe(true);
    }
  });

  it('rejects arbitrary namespaces', () => {
    expect(isRuntimeType('ns-a')).toBe(false);
    expect(isRuntimeType('my-project')).toBe(false);
    expect(isRuntimeType('')).toBe(false);
  });
});

describe('guardNamespaceCollision', () => {
  it('suffixes a namespace that equals a runtime type', () => {
    expect(guardNamespaceCollision('claude-code')).toBe('claude-code-ns');
    expect(guardNamespaceCollision('codex')).toBe('codex-ns');
    expect(guardNamespaceCollision('opencode')).toBe('opencode-ns');
    expect(guardNamespaceCollision('test-mode')).toBe('test-mode-ns');
  });

  it('leaves non-colliding namespaces untouched', () => {
    expect(guardNamespaceCollision('ns-a')).toBe('ns-a');
    expect(guardNamespaceCollision('claude-code-ns')).toBe('claude-code-ns');
  });

  it('is idempotent', () => {
    const once = guardNamespaceCollision('claude-code');
    expect(guardNamespaceCollision(once)).toBe(once);
  });
});

describe('subject builders', () => {
  it('agentSubject builds a mesh subject and guards collisions', () => {
    expect(agentSubject('ns-a', ULID)).toBe(`relay.agent.ns-a.${ULID}`);
    // A namespace named after a runtime type is guarded so it cannot masquerade
    // as a runtime-scoped session subject.
    expect(agentSubject('claude-code', ULID)).toBe(`relay.agent.claude-code-ns.${ULID}`);
  });

  it('runtimeSessionSubject builds a runtime-scoped subject', () => {
    expect(runtimeSessionSubject('codex', UUID)).toBe(`relay.agent.codex.${UUID}`);
  });

  it('legacyAgentSubject builds a 3-token subject', () => {
    expect(legacyAgentSubject(UUID)).toBe(`relay.agent.${UUID}`);
  });
});

describe('parseAgentSubject', () => {
  it('returns null for non-agent subjects', () => {
    expect(parseAgentSubject('relay.human.telegram.123')).toBeNull();
    expect(parseAgentSubject('relay.inbox.abc')).toBeNull();
    expect(parseAgentSubject('relay.agent')).toBeNull();
  });

  it('parses a legacy 3-token subject', () => {
    expect(parseAgentSubject(`relay.agent.${UUID}`)).toEqual({
      sessionId: UUID,
      format: 'legacy',
    });
  });

  it('parses a runtime-scoped subject via the closed enum', () => {
    expect(parseAgentSubject(`relay.agent.claude-code.${UUID}`)).toEqual({
      sessionId: UUID,
      runtimeType: 'claude-code',
      format: 'runtime-scoped',
    });
    expect(parseAgentSubject(`relay.agent.codex.${UUID}`)).toEqual({
      sessionId: UUID,
      runtimeType: 'codex',
      format: 'runtime-scoped',
    });
  });

  it('parses a mesh agent subject (slot 3 is a namespace, not a runtime type)', () => {
    expect(parseAgentSubject(`relay.agent.ns-a.${ULID}`)).toEqual({
      sessionId: ULID,
      namespace: 'ns-a',
      format: 'agent-scoped',
    });
  });

  it('THE COLLISION CASE: a mesh agent in a namespace named "claude-code" is unreachable by construction', () => {
    // The grammar guards namespaces at build time, so a real mesh subject can
    // never be `relay.agent.claude-code.{id}` — it is always the guarded
    // `relay.agent.claude-code-ns.{id}`, which parses as a mesh agent subject.
    const built = agentSubject('claude-code', ULID);
    expect(built).toBe(`relay.agent.claude-code-ns.${ULID}`);
    expect(parseAgentSubject(built)).toEqual({
      sessionId: ULID,
      namespace: 'claude-code-ns',
      format: 'agent-scoped',
    });

    // And a subject literally spelled `relay.agent.claude-code.{id}` is
    // unambiguously a runtime-scoped claude-code session — never a mesh agent.
    expect(parseAgentSubject(`relay.agent.claude-code.${ULID}`)).toEqual({
      sessionId: ULID,
      runtimeType: 'claude-code',
      format: 'runtime-scoped',
    });
  });

  it('preserves dotted trailing ids on runtime-scoped subjects', () => {
    expect(parseAgentSubject('relay.agent.codex.sess.with.dots')).toEqual({
      sessionId: 'sess.with.dots',
      runtimeType: 'codex',
      format: 'runtime-scoped',
    });
  });
});

describe('extractSessionIdFromSubject', () => {
  it('extracts the trailing id from every shape', () => {
    expect(extractSessionIdFromSubject(`relay.agent.${UUID}`)).toBe(UUID);
    expect(extractSessionIdFromSubject(`relay.agent.claude-code.${UUID}`)).toBe(UUID);
    expect(extractSessionIdFromSubject(`relay.agent.ns-a.${ULID}`)).toBe(ULID);
  });

  it('returns null for unparseable subjects', () => {
    expect(extractSessionIdFromSubject('relay.human.telegram.1')).toBeNull();
  });
});
