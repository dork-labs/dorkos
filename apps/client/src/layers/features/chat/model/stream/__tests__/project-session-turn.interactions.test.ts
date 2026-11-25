// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { projectInProgressTurn } from '../project-session-turn';

describe('projectInProgressTurn — approval receipts', () => {
  /** The ask, as the durable stream carries it. */
  function ask(id: string): SessionEvent {
    return {
      seq: 1,
      type: 'approval_required',
      id,
      toolName: 'Bash',
      input: '{"command":"npm test"}',
      startedAt: 1_000,
      remainingMs: 600_000,
      hasSuggestions: false,
    };
  }

  /** The tool-call part the fold produced, with its approval fields visible. */
  function approvalPart(events: SessionEvent[]) {
    return projectInProgressTurn(events)[0] as {
      approvalOutcome?: string;
      approvalResolvedAt?: number;
      status: string;
    };
  }

  it('records an approval as allowed, with when it was answered', () => {
    // Purpose: the answer has to survive on the part, not in a component — this
    // is the whole basis for a receipt that outlives the card.
    const part = approvalPart([
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('allowed');
    expect(part.approvalResolvedAt).toBe(5_000);
  });

  it('records the answer on the LIVE path, where the turn never saw the ask', () => {
    // Purpose: the shape production actually produces. A live client's store
    // routes `approval_required` to `pendingInteractions`, NOT into the turn,
    // and the resolution retires that DTO — so when the answer arrives the turn
    // holds a BARE tool_call with nothing marking it as gated. Every test that
    // seeds `approval_required` into the turn is testing the cold-snapshot
    // shape and would pass while live sessions showed no receipt at all.
    const part = approvalPart([
      { seq: 1, type: 'tool_call', toolCallId: 'tc-1', toolName: 'Bash', status: 'pending' },
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
        startedAt: 1_000,
      },
    ]) as unknown as { interactiveType?: string; approvalStartedAt?: number } & {
      approvalOutcome?: string;
    };
    expect(part.interactiveType).toBe('approval');
    expect(part.approvalOutcome).toBe('allowed');
    // The server's backfill is the only source for this on the live path.
    expect(part.approvalStartedAt).toBe(1_000);
  });

  it('does NOT mint a receipt for a timed-out question', () => {
    // Purpose: the collision that refutes "an expired resolution means an
    // approval". `handleAskUserQuestion`'s timeout calls the same
    // `notifyInteractionCancelled(..., 'timeout')` the approval path does, and
    // the normalizer maps that to `expired` for EVERY interaction kind — while
    // AskUserQuestion, being an ordinary tool_use block, has a real tool_call
    // part in the turn under the same id. Inferring the kind from the
    // resolution therefore printed "Expired — denied after 10:00" over a
    // question the person was merely asked and never answered.
    const part = approvalPart([
      {
        seq: 1,
        type: 'tool_call',
        toolCallId: 'q-1',
        toolName: 'AskUserQuestion',
        status: 'pending',
      },
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'q-1',
        kind: 'question',
        resolution: 'expired',
        at: 601_000,
        startedAt: 1_000,
      },
    ]) as unknown as { interactiveType?: string; approvalOutcome?: string };
    expect(part.approvalOutcome).toBeUndefined();
    expect(part.interactiveType).not.toBe('approval');
  });

  it('records a denial as denied', () => {
    const part = approvalPart([
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'denied',
        at: 5_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('denied');
    expect(part.status).toBe('error');
  });

  it('records a timed-out request as expired, distinct from a denial', () => {
    // Purpose: nobody answered an expired request. Folding it as `denied` would
    // put words in the operator's mouth.
    const part = approvalPart([
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'expired',
        at: 601_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('expired');
    expect(part.status).toBe('error');
  });

  it('keeps the outcome when the tool result races ahead of the resolution', () => {
    // Purpose: ordering between the runtime's tool_result and the projector's
    // resolution is not guaranteed. The receipt must not depend on winning it.
    const part = approvalPart([
      ask('tc-1'),
      { seq: 2, type: 'tool_result', toolCallId: 'tc-1', toolName: 'Bash', status: 'complete' },
      {
        seq: 3,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
      },
    ]);
    expect(part.approvalOutcome).toBe('allowed');
    expect(part.status).toBe('complete');
  });

  it('is stable across a replay that crosses the wire', () => {
    // Purpose: a reconnect replays from Last-Event-ID, and those events arrive
    // as JSON off an SSE stream — not as the objects this process happens to
    // hold. Round-tripping through serialization is what makes this a replay
    // test rather than an identity check on one array.
    const events: SessionEvent[] = [
      ask('tc-1'),
      {
        seq: 2,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'approved',
        at: 5_000,
      },
    ];
    const replayed = JSON.parse(JSON.stringify(events)) as SessionEvent[];
    expect(replayed).not.toBe(events);
    expect(projectInProgressTurn(replayed)).toEqual(projectInProgressTurn(events));
    expect(
      (projectInProgressTurn(replayed)[0] as { approvalOutcome?: string }).approvalOutcome
    ).toBe('allowed');
  });

  // DOR-939: an agent's held destructive capability call surfaces inline as the
  // same approval card the dashboard shows, and retires when the hold resolves.
  const HELD_APPROVAL = {
    approvalId: 'appr-1',
    capabilityId: 'mcp.add',
    capabilityTitle: 'Add an MCP server',
    tier: 'destructive' as const,
    summary: 'Prober wants to run "Add an MCP server"',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    requestedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T02:00:00.000Z',
  };

  it('projects a capability_approval_required event to an inline approval card', () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'text_delta', text: 'Adding the server…' },
      {
        seq: 2,
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: 1_000_000,
        capMs: 45_000,
      },
    ];
    const parts = projectInProgressTurn(events);
    // The inline card carries the SAME PendingApproval the dashboard renders, so
    // approving it resolves the same approvalId through the capability route.
    expect(parts).toEqual([
      { type: 'text', text: 'Adding the server…' },
      { type: 'capability_approval', approval: HELD_APPROVAL },
    ]);
  });

  it('retires the inline capability card on its capability_approval_resolved event', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: 1_000_000,
        capMs: 45_000,
      },
      { seq: 2, type: 'capability_approval_resolved', approvalId: 'appr-1', outcome: 'granted' },
    ];
    // The hold ended, so the card disappears from the transcript — exactly as the
    // dashboard card retires on approval_resolved.
    expect(projectInProgressTurn(events).some((p) => p.type === 'capability_approval')).toBe(false);
  });
});

// DOR-1004: an OAuth sign-in an agent asked for surfaces as a card in the
// conversation, carrying the link and the custody disclosure so the agent never
// has to paste them into its reply.
describe('mcp sign-in card', () => {
  const CARD = {
    serverName: 'granola',
    agentId: '01HV7KJZZZ0000000000000000',
    flowId: 'flow-1',
    authorizeUrl: 'https://mcp.test.local/authorize',
    disclosure: 'DorkOS stores the token on this machine.',
  };

  /** The `mcp_signin_required` event for a flow, at a given seq. */
  function required(seq: number, over: Partial<typeof CARD> = {}): SessionEvent {
    return { seq, type: 'mcp_signin_required', ...CARD, ...over } as SessionEvent;
  }

  it('projects an mcp_signin_required event to an inline sign-in card', () => {
    const parts = projectInProgressTurn([
      { seq: 1, type: 'text_delta', text: 'Connecting your meeting notes.' },
      required(2),
    ]);
    expect(parts).toEqual([
      { type: 'text', text: 'Connecting your meeting notes.' },
      { type: 'mcp_signin', ...CARD },
    ]);
  });

  it('turns the card into a receipt when the sign-in connects', () => {
    // It used to retire the part here, reasoning that the agent was already
    // resuming. That deleted the payoff about a second after it appeared and left
    // the transcript with no record that anything had been authorized.
    const parts = projectInProgressTurn([
      required(1),
      { seq: 2, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected', toolCount: 7 },
    ]);
    expect(parts).toEqual([{ type: 'mcp_signin', ...CARD, outcome: 'connected', toolCount: 7 }]);
  });

  it('keeps the card as a terminal note when the sign-in FAILED', () => {
    // Removing it would leave a person who was sent to a browser with no sign
    // anything went wrong.
    expect(
      projectInProgressTurn([
        required(1),
        { seq: 2, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'failed' },
      ])
    ).toEqual([{ type: 'mcp_signin', ...CARD, outcome: 'failed' }]);
  });

  it('replaces a LIVE card when the same server is signed in to again', () => {
    // A retry mints a NEW flow; the old link is dead the moment it does, so
    // stacking a second live card would offer a choice between a working link and
    // a broken one.
    const parts = projectInProgressTurn([
      required(1),
      required(2, { flowId: 'flow-2', authorizeUrl: 'https://mcp.test.local/authorize?2' }),
    ]);
    expect(parts).toEqual([
      {
        type: 'mcp_signin',
        ...CARD,
        flowId: 'flow-2',
        authorizeUrl: 'https://mcp.test.local/authorize?2',
      },
    ]);
  });

  it('ignores a resolution for a flow that was already replaced', () => {
    // The abandoned flow's late resolution must not settle the card that took its
    // place, which is why resolutions match on flow id and cards on server.
    const parts = projectInProgressTurn([
      required(1),
      required(2, { flowId: 'flow-2' }),
      { seq: 3, type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected' },
    ]);
    expect(parts).toEqual([{ type: 'mcp_signin', ...CARD, flowId: 'flow-2' }]);
  });
});
