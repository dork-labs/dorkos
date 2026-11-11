/** The name on an agent's window (DOR-3111). */
import { describe, expect, it } from 'vitest';
import { agentWindowName, agentWindowNameArg, MAX_WINDOW_AGENT_NAME } from '../window-name.js';

describe('agentWindowName', () => {
  it('names the agent', () => {
    expect(agentWindowName('Atlas')).toBe('Atlas is using this window');
  });

  it('says an agent is using it when the chat has no known agent', () => {
    expect(agentWindowName(null)).toBe('An agent is using this window');
    expect(agentWindowName(undefined)).toBe('An agent is using this window');
    expect(agentWindowName('')).toBe('An agent is using this window');
  });

  it('drops control and direction characters an agent could put in its name', () => {
    // U+202E reverses the text after it; a newline would split the title.
    expect(agentWindowName('Atl‮as\n')).toBe('Atlas is using this window');
    expect(agentWindowName('​‮\n')).toBe('An agent is using this window');
  });

  it('cuts a long name with an ellipsis', () => {
    const long = 'A'.repeat(MAX_WINDOW_AGENT_NAME + 6);
    expect(agentWindowName(long)).toBe(
      `${'A'.repeat(MAX_WINDOW_AGENT_NAME)}… is using this window`
    );
    expect(agentWindowName('A'.repeat(MAX_WINDOW_AGENT_NAME))).toBe(
      `${'A'.repeat(MAX_WINDOW_AGENT_NAME)} is using this window`
    );
  });

  it('never cuts a character in half', () => {
    const name = '🦊'.repeat(MAX_WINDOW_AGENT_NAME + 1);
    expect(agentWindowName(name)).toBe(
      `${'🦊'.repeat(MAX_WINDOW_AGENT_NAME)}… is using this window`
    );
  });
});

describe('agentWindowNameArg', () => {
  it('is one flag, whatever the name holds', () => {
    expect(agentWindowNameArg('Atlas --remote-debugging-port=9222')).toBe(
      '--window-name=Atlas --remote-debugging… is using this window'
    );
  });
});
