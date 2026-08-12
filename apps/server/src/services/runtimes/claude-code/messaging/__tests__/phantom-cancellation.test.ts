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
    expect(found).toEqual([{ toolUseId: 'toolu_123', mainThread: true, parentToolUseId: null }]);
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
    expect(found).toEqual([
      { toolUseId: 'toolu_123', mainThread: false, parentToolUseId: 'toolu_parent' },
    ]);
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

  it('ignores replayed history on resume (isReplay) — old real stops are not phantoms', () => {
    const msg = userMessage([{ toolUseId: 'toolu_from_last_week' }]) as unknown as {
      isReplay?: boolean;
    };
    msg.isReplay = true;
    expect(detectPhantomCancellations(msg as unknown as SDKMessage, makeSession())).toEqual([]);
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
    const note = buildPhantomCorrectionNote([
      { toolUseId: 'toolu_abc', mainThread: true, parentToolUseId: null },
    ]);
    expect(note).toContain('toolu_abc');
    expect(note).toContain('not by the user');
    expect(note).toContain('did NOT deny');
  });

  it('names every cancelled call in one note', () => {
    const note = buildPhantomCorrectionNote([
      { toolUseId: 'toolu_A', mainThread: true, parentToolUseId: null },
      { toolUseId: 'toolu_B', mainThread: true, parentToolUseId: null },
    ]);
    expect(note).toContain('toolu_A');
    expect(note).toContain('toolu_B');
  });

  // A subagent's own input stream is not ours to write to, but the coordinator
  // that dispatched it IS reachable — and it is the one about to believe a false
  // "the user declined" in the subagent's report (DOR-1150).
  describe('subagent phantoms', () => {
    const subagentPhantoms = [
      { toolUseId: 'toolu_sub_A', mainThread: false, parentToolUseId: 'toolu_task_1' },
      { toolUseId: 'toolu_sub_B', mainThread: false, parentToolUseId: 'toolu_task_1' },
    ];

    it('names the dispatching task and every cancelled call inside it', () => {
      const note = buildPhantomCorrectionNote(subagentPhantoms);
      expect(note).toContain('toolu_task_1');
      expect(note).toContain('toolu_sub_A');
      expect(note).toContain('toolu_sub_B');
    });

    it('tells the coordinator the runtime cancelled them, not the user', () => {
      const note = buildPhantomCorrectionNote(subagentPhantoms);
      expect(note).toContain('not by the user');
    });

    it("marks any 'user declined' claim in that subagent's report as false", () => {
      const note = buildPhantomCorrectionNote(subagentPhantoms);
      expect(note).toContain('FALSE');
      expect(note.toLowerCase()).toContain('declined');
    });

    it('tells the coordinator to re-issue or re-dispatch the work', () => {
      const note = buildPhantomCorrectionNote(subagentPhantoms);
      expect(note.toLowerCase()).toMatch(/re-?dispatch|re-?issue/);
    });
  });
});
