import { describe, it, expect } from 'vitest';
import {
  CLI_INTERRUPT_SENTINEL,
  INTERRUPT_SUPPRESSION_WINDOW_MS,
  detectPhantomCancellation,
  buildPhantomCorrectionNote,
} from '../phantom-cancellation.js';
import type { AgentSession } from '../../agent-types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function sentinelUserMessage(opts: {
  toolUseId?: string;
  parentToolUseId?: string | null;
  content?: unknown;
}): SDKMessage {
  return {
    type: 'user',
    uuid: 'u-1',
    session_id: 'sdk-1',
    parent_tool_use_id: opts.parentToolUseId ?? null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: opts.toolUseId ?? 'toolu_123',
          is_error: true,
          content: opts.content ?? CLI_INTERRUPT_SENTINEL,
        },
      ],
    },
  } as unknown as SDKMessage;
}

describe('detectPhantomCancellation', () => {
  it('detects a main-thread sentinel tool_result with no operator action behind it', () => {
    const found = detectPhantomCancellation(sentinelUserMessage({}), makeSession());
    expect(found).toEqual({ toolUseId: 'toolu_123', mainThread: true });
  });

  it('detects the sentinel when the tool_result content is a text-block array', () => {
    const found = detectPhantomCancellation(
      sentinelUserMessage({ content: [{ type: 'text', text: CLI_INTERRUPT_SENTINEL }] }),
      makeSession()
    );
    expect(found?.toolUseId).toBe('toolu_123');
  });

  it('flags a subagent phantom as not main-thread', () => {
    const found = detectPhantomCancellation(
      sentinelUserMessage({ parentToolUseId: 'toolu_parent' }),
      makeSession()
    );
    expect(found).toEqual({ toolUseId: 'toolu_123', mainThread: false });
  });

  it('ignores a tool call the operator actually denied', () => {
    const session = makeSession({ operatorDeniedToolIds: new Set(['toolu_123']) });
    expect(detectPhantomCancellation(sentinelUserMessage({}), session)).toBeNull();
  });

  it('ignores sentinels inside the post-interrupt suppression window', () => {
    const now = 1_000_000;
    const session = makeSession({ interruptRequestedAt: now - 1_000 });
    expect(detectPhantomCancellation(sentinelUserMessage({}), session, now)).toBeNull();
  });

  it('detects again once the interrupt suppression window has passed', () => {
    const now = 1_000_000;
    const session = makeSession({
      interruptRequestedAt: now - INTERRUPT_SUPPRESSION_WINDOW_MS - 1,
    });
    expect(detectPhantomCancellation(sentinelUserMessage({}), session, now)).not.toBeNull();
  });

  it('ignores a real DorkOS deny message (different wording)', () => {
    const found = detectPhantomCancellation(
      sentinelUserMessage({ content: 'User denied tool execution. Reason: not now' }),
      makeSession()
    );
    expect(found).toBeNull();
  });

  it('ignores non-user messages and plain-text user messages', () => {
    const session = makeSession();
    expect(
      detectPhantomCancellation({ type: 'result' } as unknown as SDKMessage, session)
    ).toBeNull();
    expect(
      detectPhantomCancellation(
        {
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: CLI_INTERRUPT_SENTINEL },
        } as unknown as SDKMessage,
        session
      )
    ).toBeNull();
  });
});

describe('buildPhantomCorrectionNote', () => {
  it('names the cancelled tool call and says the user did not deny it', () => {
    const note = buildPhantomCorrectionNote('toolu_abc');
    expect(note).toContain('toolu_abc');
    expect(note).toContain('not by the user');
    expect(note).toContain('did NOT deny');
  });
});
