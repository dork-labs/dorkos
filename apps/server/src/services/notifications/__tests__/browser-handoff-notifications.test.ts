import { describe, expect, it } from 'vitest';
import { BROWSER_HANDOFF_ENTRIES } from '../browser-handoff-notifications.js';

const entry = BROWSER_HANDOFF_ENTRIES['browser.handoff'];
const payload = {
  handoffId: 'h1',
  sessionId: 'chat-1',
  site: 'northwind.example',
  agentName: 'Atlas',
  agentId: 'agent-1',
};

describe('browser.handoff', () => {
  it('uses fixed words plus the site and the agent’s name', () => {
    expect(entry.title).toBeTypeOf('function');
    expect((entry.title as (p: typeof payload) => string)(payload)).toBe(
      'northwind.example wants a person to continue'
    );
    expect((entry.body as (p: typeof payload) => string)(payload)).toBe(
      'Atlas is paused. Continue on your computer.'
    );
  });

  it('says "The agent" with no verified name, and cuts a long one short', () => {
    const body = entry.body as (p: typeof payload | { agentName: string | null }) => string;
    expect(body({ ...payload, agentName: null })).toMatch(/^The agent is paused/);
    expect(body({ ...payload, agentName: 'x'.repeat(500) })).toBe(
      `${'x'.repeat(40)}… is paused. Continue on your computer.`
    );
  });

  it('strips control and direction characters from a name', () => {
    const body = entry.body as (p: typeof payload) => string;
    expect(body({ ...payload, agentName: 'At\u202Elas\n' })).toMatch(/^Atlas is paused/);
    expect(body({ ...payload, agentName: '\u202E' })).toMatch(/^The agent is paused/);
  });

  it('has no buttons, never leaves the app, and is one row per handoff', () => {
    expect(entry.actions).toBeUndefined();
    expect(entry.relay).toBe('never');
    expect(entry.dedupeKey(payload)).toBe('browser-handoff:h1');
  });
});
