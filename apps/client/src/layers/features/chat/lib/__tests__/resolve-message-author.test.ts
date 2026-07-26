import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@/layers/shared/model';
import { resolveMessageAuthor, type MessageAuthorAgent } from '../resolve-message-author';

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hello',
    parts: [],
    timestamp: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

const agent: MessageAuthorAgent = {
  id: 'agent-123',
  displayName: 'DorkBot',
  emoji: '🤖',
  color: '#6366f1',
};

describe('resolveMessageAuthor', () => {
  it('resolves an assistant message to the session agent when there is one', () => {
    expect(resolveMessageAuthor(msg(), { agent, runtime: 'claude-code' })).toEqual({
      kind: 'agent',
      id: 'agent-123',
      displayName: 'DorkBot',
      emoji: '🤖',
      color: '#6366f1',
    });
  });

  it('falls back to the runtime brand when no agent is registered', () => {
    expect(resolveMessageAuthor(msg(), { runtime: 'claude-code' })).toEqual({
      kind: 'agent',
      id: 'runtime:claude-code',
      displayName: 'Claude',
      runtime: 'claude-code',
    });
    expect(resolveMessageAuthor(msg(), { agent: null, runtime: 'codex' }).displayName).toBe(
      'Codex'
    );
    expect(resolveMessageAuthor(msg(), { runtime: 'opencode' }).displayName).toBe('OpenCode');
  });

  it('uses the raw runtime type when the runtime is unknown', () => {
    expect(resolveMessageAuthor(msg(), { runtime: 'future-runtime' })).toEqual({
      kind: 'agent',
      id: 'runtime:future-runtime',
      displayName: 'future-runtime',
      runtime: 'future-runtime',
    });
  });

  it('never returns a bare "Assistant" when neither agent nor runtime is known', () => {
    const author = resolveMessageAuthor(msg(), {});
    expect(author).toEqual({ kind: 'agent', id: 'agent', displayName: 'Agent' });
    expect(author.displayName).not.toBe('Assistant');
  });

  it('treats a blank runtime as no runtime', () => {
    expect(resolveMessageAuthor(msg(), { runtime: '   ' }).displayName).toBe('Agent');
  });

  it('resolves a user message to the human', () => {
    expect(resolveMessageAuthor(msg({ role: 'user' }), { agent, runtime: 'claude-code' })).toEqual({
      kind: 'human',
      id: 'human',
      displayName: 'You',
    });
  });

  it('uses the supplied human name when there is one', () => {
    expect(resolveMessageAuthor(msg({ role: 'user' }), { humanName: 'Dorian' }).displayName).toBe(
      'Dorian'
    );
  });

  it('falls back to the default name when the supplied human name is blank', () => {
    expect(resolveMessageAuthor(msg({ role: 'user' }), { humanName: '  ' }).displayName).toBe(
      'You'
    );
    expect(resolveMessageAuthor(msg({ role: 'user' }), { humanName: null }).displayName).toBe(
      'You'
    );
  });

  it('keeps a slash-command message with the human who typed it', () => {
    expect(
      resolveMessageAuthor(msg({ role: 'user', messageType: 'command' }), { humanName: 'Dorian' })
    ).toEqual({ kind: 'human', id: 'human', displayName: 'Dorian' });
  });

  it('resolves local command output to the system, not the human', () => {
    expect(
      resolveMessageAuthor(msg({ role: 'user', messageType: 'local_command_output' }), {
        humanName: 'Dorian',
      })
    ).toEqual({ kind: 'system', id: 'system', displayName: 'System' });
  });

  it('resolves a compaction marker to the system', () => {
    expect(
      resolveMessageAuthor(msg({ role: 'user', messageType: 'compaction' }), { agent })
    ).toEqual({ kind: 'system', id: 'system', displayName: 'System' });
  });

  it('resolves system messages before role, whatever the role is', () => {
    expect(
      resolveMessageAuthor(msg({ role: 'assistant', messageType: 'local_command_output' }), {
        agent,
      }).kind
    ).toBe('system');
  });
});
