import { describe, it, expect } from 'vitest';
import { wrapKickoff, isKickoffEnvelope, filterKickoffHistory, KICKOFF_TAG } from '../kickoff.js';

const ENVELOPE = wrapKickoff('introduce yourself from SOUL.md');

/** Shorthand for a history message. */
function msg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

describe('wrapKickoff', () => {
  it('fences the instruction with the kickoff tag', () => {
    expect(ENVELOPE.startsWith(`<${KICKOFF_TAG}>`)).toBe(true);
    expect(ENVELOPE.endsWith(`</${KICKOFF_TAG}>`)).toBe(true);
    expect(ENVELOPE).toContain('introduce yourself');
  });

  it('round-trips: a wrapped instruction is an exact envelope', () => {
    expect(isKickoffEnvelope(ENVELOPE)).toBe(true);
  });
});

describe('isKickoffEnvelope — exact structural match', () => {
  it('accepts the envelope with prepended git_status context (ADR-0273)', () => {
    const withContext = `<git_status>\nIs git repo: false\n</git_status>\n\n${ENVELOPE}`;
    expect(isKickoffEnvelope(withContext)).toBe(true);
  });

  it('rejects an ordinary message', () => {
    expect(isKickoffEnvelope('set up my API key please')).toBe(false);
  });

  it('rejects a mid-text mention of the tag', () => {
    expect(isKickoffEnvelope('what does <dork-kickoff> mean?')).toBe(false);
  });
});

// The reviewer-executed exploits against the old either/or predicate. Every
// case below was suppressed (hidden forever) before the envelope rework; each
// must now stay visible. These are preservation tests: genuine content that
// merely touches the marker is NEVER captured.
describe('adversarial preservation — genuine content is never suppressed', () => {
  it('a user message STARTING with the open tag only is shown', () => {
    const history = [msg('user', '<dork-kickoff> what is this?'), msg('assistant', 'a marker')];
    expect(filterKickoffHistory(history)).toBe(history);
  });

  it('a user message ENDING with the close tag only is shown', () => {
    const history = [
      msg('user', 'here is how fences work ... </dork-kickoff>'),
      msg('assistant', 'ok'),
    ];
    expect(filterKickoffHistory(history)).toBe(history);
  });

  it('an ASSISTANT message ending with the close tag is shown (role scope)', () => {
    // Even a full-envelope assistant message is out of scope: the filter only
    // ever judges user records.
    const history = [msg('user', 'hi'), msg('assistant', `I emit ${ENVELOPE}`)];
    expect(filterKickoffHistory(history)).toBe(history);
    const fullEnvelopeAssistant = [msg('user', 'hi'), msg('assistant', ENVELOPE)];
    expect(filterKickoffHistory(fullEnvelopeAssistant)).toBe(fullEnvelopeAssistant);
  });

  it('a full-envelope user paste LATER in the conversation is shown (first-user-record scope)', () => {
    const history = [msg('user', 'hello'), msg('assistant', 'hi'), msg('user', ENVELOPE)];
    expect(filterKickoffHistory(history)).toBe(history);
  });
});

describe('filterKickoffHistory — the suppression seam', () => {
  it('drops the kickoff when it is the first user record', () => {
    const history = [msg('user', ENVELOPE), msg('assistant', "Hi — I'm Keeper.")];
    const filtered = filterKickoffHistory(history);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].role).toBe('assistant');
  });

  it('drops the kickoff when the runtime stored it with prepended context', () => {
    const stored = `<git_status>\nIs git repo: true\n</git_status>\n\n${ENVELOPE}`;
    const history = [msg('user', stored), msg('assistant', 'greeting')];
    expect(filterKickoffHistory(history)).toHaveLength(1);
  });

  it('suppresses a deliberate full-envelope first-message paste (the documented residual)', () => {
    // Accepted residual per the module doc: an exact, complete envelope as the
    // entire first user message is indistinguishable from the real kickoff.
    const history = [msg('user', ENVELOPE), msg('assistant', 'reply')];
    expect(filterKickoffHistory(history)).toHaveLength(1);
  });

  it('returns the same array reference when nothing is suppressed', () => {
    const history = [msg('user', 'hello'), msg('assistant', 'hi')];
    expect(filterKickoffHistory(history)).toBe(history);
  });

  it('handles an empty or assistant-only history', () => {
    expect(filterKickoffHistory([])).toEqual([]);
    const assistantOnly = [msg('assistant', ENVELOPE)];
    expect(filterKickoffHistory(assistantOnly)).toBe(assistantOnly);
  });
});
