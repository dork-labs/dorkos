/** What a teammate's turn may ask the owner for (DOR-2956). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  askCallHash,
  askOwner,
  askableRefusal,
  canonicalAskCall,
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
});
