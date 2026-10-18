/** What a teammate's turn may ask the owner for (DOR-2956). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  askCallHash,
  askOwner,
  askableRefusal,
  canonicalAskCall,
  hiddenCharacterRefusal,
  setAskOwnerPort,
} from '../ask-owner.js';

const SCOPE = {
  roomId: 'room-a',
  authorId: 'agent-a',
  asker: { memberId: 'member-bo', displayName: 'Bo' },
};

afterEach(() => setAskOwnerPort(undefined));

describe('ask the owner', () => {
  it.each(['Bash', 'Read', 'Edit', 'Write', 'WebFetch'])('lets %s be asked for', (tool) => {
    expect(askableRefusal(tool)).toBeNull();
  });

  it.each([
    'mcp__composio__GMAIL_SEND',
    'mcp__nango__create_issue',
    'mcp__dorkos__chat_read',
    'Agent',
    'Task',
    'Skill',
    'TodoWrite',
  ])('refuses to ask for %s', (tool) => {
    expect(askableRefusal(tool)).toEqual(expect.any(String));
  });

  it('says connected apps can’t be asked for', () => {
    expect(askableRefusal('mcp__composio__GMAIL_SEND')).toMatch(/Connected apps/);
  });

  it('never reaches the port for a tool that can’t be asked for', async () => {
    const request = vi.fn();
    setAskOwnerPort({ request, spend: () => false });
    const result = await askOwner(SCOPE, { tool: 'mcp__composio__X', input: {}, why: 'w' });
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses when nothing is wired', async () => {
    expect((await askOwner(SCOPE, { tool: 'Bash', input: { command: 'ls' }, why: 'w' })).ok).toBe(
      false
    );
  });

  it('drops Bash’s label and zero-width spaces, and nothing else', () => {
    expect(
      canonicalAskCall('Bash', { command: 'a​@b', description: 'x', run_in_background: true })
    ).toEqual({ tool: 'Bash', input: { command: 'a@b', run_in_background: true } });
    expect(askCallHash('Bash', { command: 'ls' })).not.toBe(
      askCallHash('Bash', { command: 'ls ' })
    );
    expect(askCallHash('Bash', { command: 'ls' })).not.toBe(askCallHash('Read', { command: 'ls' }));
  });

  it.each([
    ['a right-to-left override', { command: 'ls \u202E' }],
    ['an isolate', { command: 'ls \u2066x\u2069' }],
    ['a zero-width joiner', { command: 'r\u200Dm' }],
    ['a byte-order mark', { command: '\uFEFFls' }],
    ['a word joiner in a key', { ['comm\u2060and']: 'ls' }],
    ['one nested in a list', { args: ['ok', 'x\u200E'] }],
  ])('refuses an input with %s, before the port', async (_, input) => {
    const request = vi.fn();
    setAskOwnerPort({ request, spend: () => false });
    expect(hiddenCharacterRefusal('Bash', input)).toMatch(/hidden or direction-changing/);
    expect((await askOwner(SCOPE, { tool: 'Bash', input, why: 'w' })).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('takes out the zero-width space defusing adds, and refuses nothing for it', () => {
    expect(hiddenCharacterRefusal('Bash', { command: 'echo \u200B@x' })).toBeNull();
  });
});
