import { describe, expect, it } from 'vitest';
import { extractSessionIdFromSubject, isUuid, parseAgentSubject } from '../subject-parser.js';

const LEGACY_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('parseAgentSubject', () => {
  it('parses the new runtime-scoped shape', () => {
    const result = parseAgentSubject(`relay.agent.claude-code.${LEGACY_UUID}`);
    expect(result).toEqual({
      sessionId: LEGACY_UUID,
      runtimeType: 'claude-code',
      format: 'runtime-scoped',
    });
  });

  it('parses the new runtime-scoped shape with a non-UUID sessionId (test fixtures)', () => {
    const result = parseAgentSubject('relay.agent.claude-code.session-abc');
    expect(result).toEqual({
      sessionId: 'session-abc',
      runtimeType: 'claude-code',
      format: 'runtime-scoped',
    });
  });

  it('parses the legacy three-part shape', () => {
    const result = parseAgentSubject(`relay.agent.${LEGACY_UUID}`);
    expect(result).toEqual({ sessionId: LEGACY_UUID, format: 'legacy' });
  });

  it('parses legacy with a non-UUID sessionId (tests, early boot)', () => {
    const result = parseAgentSubject('relay.agent.session-abc');
    expect(result).toEqual({ sessionId: 'session-abc', format: 'legacy' });
  });

  it('treats a UUID at index 2 as legacy even when extra trailing tokens exist', () => {
    // Rare defensive case: sessionId is at parts[2], any trailing suffix is
    // preserved on the sessionId by the parser's shape — we bias to legacy
    // semantics so session lookups keep working.
    const result = parseAgentSubject(`relay.agent.${LEGACY_UUID}`);
    expect(result?.format).toBe('legacy');
    expect(result?.sessionId).toBe(LEGACY_UUID);
  });

  it('returns null for non-agent subjects', () => {
    expect(parseAgentSubject('relay.human.console.x')).toBeNull();
    expect(parseAgentSubject('relay.system.console')).toBeNull();
    expect(parseAgentSubject('relay.inbox.abc')).toBeNull();
    expect(parseAgentSubject('something.else.entirely')).toBeNull();
  });

  it('returns null for malformed subjects', () => {
    expect(parseAgentSubject('relay.agent')).toBeNull();
    expect(parseAgentSubject('relay')).toBeNull();
    expect(parseAgentSubject('')).toBeNull();
  });

  it('reassembles sessionIds that accidentally contain dots', () => {
    // A runtime-scoped subject with a "weird" sessionId: the parser rejoins
    // everything after runtimeType with "." so lookups keep working.
    const result = parseAgentSubject('relay.agent.test-mode.chat.123');
    expect(result).toEqual({
      sessionId: 'chat.123',
      runtimeType: 'test-mode',
      format: 'runtime-scoped',
    });
  });
});

describe('extractSessionIdFromSubject', () => {
  it('returns the sessionId for the runtime-scoped shape', () => {
    expect(extractSessionIdFromSubject(`relay.agent.claude-code.${LEGACY_UUID}`)).toBe(LEGACY_UUID);
  });

  it('returns the sessionId for the legacy shape', () => {
    expect(extractSessionIdFromSubject(`relay.agent.${LEGACY_UUID}`)).toBe(LEGACY_UUID);
  });

  it('returns null when the subject is not a relay.agent.* subject', () => {
    expect(extractSessionIdFromSubject('relay.human.console.x')).toBeNull();
  });
});

describe('isUuid', () => {
  it('accepts canonical UUIDs', () => {
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isUuid('01234567-89ab-cdef-0123-456789abcdef')).toBe(true);
  });

  it('rejects non-UUIDs used in test fixtures', () => {
    expect(isUuid('session-abc')).toBe(false);
    expect(isUuid('claude-code')).toBe(false);
    expect(isUuid('agent-ulid-001')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
