import { describe, it, expect } from 'vitest';
import {
  checkAdapterEntries,
  checkDuplicateAgentIds,
  checkRelayAccessRules,
  checkRelayBindingGhosts,
  checkRoomSessionTranscripts,
} from '../checks.js';

describe('checkRoomSessionTranscripts', () => {
  it('passes when every binding has a transcript', () => {
    const result = checkRoomSessionTranscripts({ judgedCount: 2, orphaned: [] });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('2 room members');
  });

  it('passes vacuously with no bindings', () => {
    const result = checkRoomSessionTranscripts({ judgedCount: 0, orphaned: [] });
    expect(result.status).toBe('pass');
  });

  it('warns and counts the bindings whose transcript is gone', () => {
    const result = checkRoomSessionTranscripts({
      judgedCount: 3,
      orphaned: [
        { roomId: 'r1', authorId: 'a1', sessionId: 'gone-1' },
        { roomId: 'r2', authorId: 'a2', sessionId: 'gone-2' },
      ],
    });
    expect(result.status).toBe('warn');
    expect(result.label).toContain('2 room members');
    expect(result.detail).toContain('2 rooms');
    expect(result.fix).toBeTruthy();
  });

  it('says it could not check when nothing could be read', () => {
    const result = checkRoomSessionTranscripts({
      judgedCount: 0,
      orphaned: [],
      unreadableCount: 4,
    });
    expect(result.status).toBe('info');
    expect(result.label).toContain('Could not check');
    expect(result.detail).toContain('4 room members');
  });

  it('still passes on zero bindings when nothing was unreadable', () => {
    const result = checkRoomSessionTranscripts({
      judgedCount: 0,
      orphaned: [],
      unreadableCount: 0,
    });
    expect(result.status).toBe('pass');
  });

  it('admits on a pass how many bindings it had to leave out', () => {
    const result = checkRoomSessionTranscripts({
      judgedCount: 1,
      orphaned: [],
      unreadableCount: 2,
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('2 could not be read');
  });

  it('carries no session id, room id, or path', () => {
    const result = checkRoomSessionTranscripts({
      judgedCount: 1,
      orphaned: [{ roomId: 'secret-room', authorId: 'agent', sessionId: 'secret-session' }],
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('secret-room');
    expect(rendered).not.toContain('secret-session');
  });
});

describe('checkRelayAccessRules', () => {
  it('passes with a readable rule list', () => {
    const result = checkRelayAccessRules({ quarantined: false, ruleCount: 3 });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('3 rules');
  });

  it('fails while quarantined, because everything is being denied', () => {
    const result = checkRelayAccessRules({ quarantined: true, ruleCount: 0 });
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('access-rules.json');
  });
});

describe('checkAdapterEntries', () => {
  it('passes when every saved integration was readable', () => {
    expect(checkAdapterEntries({ unparsedCount: 0 }).status).toBe('pass');
  });

  it('warns and says the credential may still be in plain text', () => {
    const result = checkAdapterEntries({ unparsedCount: 2 });
    expect(result.status).toBe('warn');
    expect(result.label).toContain('2 chat integrations');
    expect(result.detail).toContain('plain text');
  });
});

describe('checkDuplicateAgentIds', () => {
  it('passes when every id belongs to one folder', () => {
    const result = checkDuplicateAgentIds({
      manifests: [
        { id: 'a', directory: '/one' },
        { id: 'b', directory: '/two' },
      ],
    });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('2 agents');
  });

  it('ignores the same folder listed twice', () => {
    const result = checkDuplicateAgentIds({
      manifests: [
        { id: 'a', directory: '/one' },
        { id: 'a', directory: '/one' },
      ],
    });
    expect(result.status).toBe('pass');
  });

  it('warns when one id is claimed by two folders', () => {
    const result = checkDuplicateAgentIds({
      manifests: [
        { id: 'shared', directory: '/one' },
        { id: 'shared', directory: '/copy' },
        { id: 'other', directory: '/three' },
      ],
    });
    expect(result.status).toBe('warn');
    expect(result.label).toContain('1 agent id is');
  });

  it('names no folder', () => {
    const result = checkDuplicateAgentIds({
      manifests: [
        { id: 'shared', directory: '/Users/someone/private-project' },
        { id: 'shared', directory: '/Users/someone/private-copy' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private-project');
  });
});

describe('checkRelayBindingGhosts', () => {
  it('passes when every binding resolves on both ends', () => {
    const result = checkRelayBindingGhosts({
      bindings: [{ adapterId: 'slack', agentId: 'agent-1' }],
      knownAdapterIds: new Set(['slack']),
      registeredAgentIds: new Set(['agent-1']),
    });
    expect(result.status).toBe('pass');
  });

  it('warns when the agent is no longer registered', () => {
    const result = checkRelayBindingGhosts({
      bindings: [{ adapterId: 'slack', agentId: 'ghost' }],
      knownAdapterIds: new Set(['slack']),
      registeredAgentIds: new Set(),
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('agent DorkOS does not know about');
  });

  it('warns when the integration is gone', () => {
    const result = checkRelayBindingGhosts({
      bindings: [{ adapterId: 'deleted', agentId: 'agent-1' }],
      knownAdapterIds: new Set(),
      registeredAgentIds: new Set(['agent-1']),
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('chat integration that no longer exists');
  });

  it('counts a binding broken on both ends once', () => {
    const result = checkRelayBindingGhosts({
      bindings: [{ adapterId: 'deleted', agentId: 'ghost' }],
      knownAdapterIds: new Set(),
      registeredAgentIds: new Set(),
    });
    expect(result.label).toContain('1 chat connection is');
    expect(result.detail).toContain('chat integration that no longer exists');
    expect(result.detail).toContain('agent DorkOS does not know about');
  });
});
