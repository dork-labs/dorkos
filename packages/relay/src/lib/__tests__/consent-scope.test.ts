import { describe, it, expect } from 'vitest';
import { requiresInitiateConsent, isConsoleSubject } from '../consent-scope.js';

describe('requiresInitiateConsent', () => {
  it('covers every bound external human channel', () => {
    expect(requiresInitiateConsent('relay.human.telegram.tg1.chat-42')).toBe(true);
    expect(requiresInitiateConsent('relay.human.slack.s1.C123')).toBe(true);
    // Even a shape nobody has built yet: the prefix is what decides.
    expect(requiresInitiateConsent('relay.human.discord.d1.general')).toBe(true);
  });

  it('leaves agent and system traffic alone', () => {
    expect(requiresInitiateConsent('relay.agent.ns.agent-1')).toBe(false);
    expect(requiresInitiateConsent('relay.system.tasks.notifier')).toBe(false);
    expect(requiresInitiateConsent('relay.inbox.query.caller-1')).toBe(false);
  });

  it("carves out the operator's own console", () => {
    expect(requiresInitiateConsent('relay.human.console')).toBe(false);
    expect(requiresInitiateConsent('relay.human.console.client-9')).toBe(false);
  });

  it('does not hand the console carve-out to a subject that merely starts like it', () => {
    // A `startsWith('relay.human.console')` test would exempt an adapter named
    // `consolidated` — a channel reaching a real person, gated by nothing.
    expect(requiresInitiateConsent('relay.human.consolidated.c1.chat')).toBe(true);
    expect(isConsoleSubject('relay.human.consolidated.c1.chat')).toBe(false);
    expect(isConsoleSubject('relay.human.console')).toBe(true);
    expect(isConsoleSubject('relay.human.console.client-9')).toBe(true);
  });
});
