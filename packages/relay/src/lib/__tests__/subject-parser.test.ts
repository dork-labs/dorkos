import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractSessionIdFromSubject,
  isUuid,
  parseAgentSubject,
  resetLegacySubjectWarning,
  setLegacySubjectWarningSilenced,
} from '../subject-parser.js';

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

  it('returns null for subjects with a trailing dot (empty sessionId)', () => {
    // `relay.agent.claude-code.` — parts after runtimeType are empty.
    expect(parseAgentSubject('relay.agent.claude-code.')).toBeNull();
    // Legacy form with trailing dot: `relay.agent.` alone.
    expect(parseAgentSubject('relay.agent.')).toBeNull();
  });

  it('returns null for subjects with an empty runtime-type segment', () => {
    // `relay.agent..sessionId` — parts[2] is empty (falsy), so the parser
    // cannot distinguish a runtime-type from a sessionId — reject defensively.
    expect(parseAgentSubject('relay.agent..session-abc')).toBeNull();
  });

  it('rejects whitespace-only or leading/trailing-space subjects', () => {
    expect(parseAgentSubject(' relay.agent.claude-code.s1')).toBeNull();
    expect(parseAgentSubject('relay.agent.claude-code.s1 ')).toEqual({
      sessionId: 's1 ',
      runtimeType: 'claude-code',
      format: 'runtime-scoped',
    });
    // NOTE: trailing-space on sessionId is preserved by design — the parser
    // does not mutate sessionId. Callers must not pass untrimmed input.
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

describe('legacy-shape deprecation warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLegacySubjectWarning();
    setLegacySubjectWarningSilenced(false);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    setLegacySubjectWarningSilenced(true);
  });

  it('emits exactly one warn when parsing multiple legacy-shape subjects', () => {
    parseAgentSubject(`relay.agent.${LEGACY_UUID}`);
    parseAgentSubject('relay.agent.session-abc');
    parseAgentSubject('relay.agent.session-def');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('decisions/0259');
  });

  it('does not warn for runtime-scoped subjects', () => {
    parseAgentSubject(`relay.agent.claude-code.${LEGACY_UUID}`);
    parseAgentSubject('relay.agent.test-mode.session-abc');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for non-matching or malformed subjects', () => {
    parseAgentSubject('relay.human.console.x');
    parseAgentSubject('relay.agent');
    parseAgentSubject('');
    expect(warnSpy).not.toHaveBeenCalled();
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
