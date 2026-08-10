import { describe, it, expect } from 'vitest';
import {
  CLI_INTERRUPT_SENTINEL,
  INTERRUPT_SUPPRESSION_WINDOW_MS,
  detectPhantomCancellations,
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

interface ResultBlock {
  toolUseId?: string;
  content?: unknown;
  isError?: boolean;
}

function userMessage(blocks: ResultBlock[], parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'user',
    uuid: 'u-1',
    session_id: 'sdk-1',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'user',
      content: blocks.map((b) => ({
        type: 'tool_result',
        tool_use_id: b.toolUseId ?? 'toolu_123',
        is_error: b.isError ?? true,
        content: b.content ?? CLI_INTERRUPT_SENTINEL,
      })),
    },
  } as unknown as SDKMessage;
}

describe('detectPhantomCancellations', () => {
  it('detects a main-thread sentinel tool_result with no operator stop behind it', () => {
    const found = detectPhantomCancellations(userMessage([{}]), makeSession());
    expect(found).toEqual([{ toolUseId: 'toolu_123', mainThread: true }]);
  });

  it('detects EVERY phantom when the CLI cancels parallel calls in one message', () => {
    const found = detectPhantomCancellations(
      userMessage([{ toolUseId: 'toolu_A' }, { toolUseId: 'toolu_B' }, { toolUseId: 'toolu_C' }]),
      makeSession()
    );
    expect(found.map((p) => p.toolUseId)).toEqual(['toolu_A', 'toolu_B', 'toolu_C']);
  });

  it('detects the sentinel in any text block, not only the first', () => {
    const found = detectPhantomCancellations(
      userMessage([
        {
          content: [
            { type: 'text', text: 'Interrupted by user' },
            { type: 'text', text: CLI_INTERRUPT_SENTINEL },
          ],
        },
      ]),
      makeSession()
    );
    expect(found).toHaveLength(1);
  });

  it('tolerates surrounding whitespace in the sentinel text', () => {
    const found = detectPhantomCancellations(
      userMessage([{ content: `${CLI_INTERRUPT_SENTINEL}\n` }]),
      makeSession()
    );
    expect(found).toHaveLength(1);
  });

  it('ignores a NON-error tool_result that merely contains the sentinel text', () => {
    const found = detectPhantomCancellations(userMessage([{ isError: false }]), makeSession());
    expect(found).toEqual([]);
  });

  it('flags a subagent phantom as not main-thread', () => {
    const found = detectPhantomCancellations(userMessage([{}], 'toolu_parent'), makeSession());
    expect(found).toEqual([{ toolUseId: 'toolu_123', mainThread: false }]);
  });

  it('ignores sentinels inside the post-interrupt suppression window', () => {
    const now = 1_000_000;
    const session = makeSession({ interruptRequestedAt: now - 1_000 });
    expect(detectPhantomCancellations(userMessage([{}]), session, now)).toEqual([]);
  });

  it('detects again once the interrupt suppression window has passed', () => {
    const now = 1_000_000;
    const session = makeSession({
      interruptRequestedAt: now - INTERRUPT_SUPPRESSION_WINDOW_MS - 1,
    });
    expect(detectPhantomCancellations(userMessage([{}]), session, now)).toHaveLength(1);
  });

  it('ignores a real DorkOS deny message (different wording)', () => {
    const found = detectPhantomCancellations(
      userMessage([{ content: 'User denied tool execution. Reason: not now' }]),
      makeSession()
    );
    expect(found).toEqual([]);
  });

  it('ignores non-user messages and plain-text user messages', () => {
    const session = makeSession();
    expect(
      detectPhantomCancellations({ type: 'result' } as unknown as SDKMessage, session)
    ).toEqual([]);
    expect(
      detectPhantomCancellations(
        {
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: CLI_INTERRUPT_SENTINEL },
        } as unknown as SDKMessage,
        session
      )
    ).toEqual([]);
  });
});

describe('buildPhantomCorrectionNote', () => {
  it('names the cancelled tool call and says the user did not deny it', () => {
    const note = buildPhantomCorrectionNote(['toolu_abc']);
    expect(note).toContain('toolu_abc');
    expect(note).toContain('not by the user');
    expect(note).toContain('did NOT deny');
  });

  it('names every cancelled call in one note', () => {
    const note = buildPhantomCorrectionNote(['toolu_A', 'toolu_B']);
    expect(note).toContain('toolu_A');
    expect(note).toContain('toolu_B');
  });
});
