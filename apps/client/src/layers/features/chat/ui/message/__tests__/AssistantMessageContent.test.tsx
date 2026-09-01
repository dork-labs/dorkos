/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { AssistantMessageContent } from '../AssistantMessageContent';
import type { ChatMessage } from '../../../model/use-chat-session';

// Mock StreamingText to simplify rendering
vi.mock('../StreamingText', () => ({
  StreamingText: ({ content }: { content: string }) => (
    <span data-testid="streaming-text">{content}</span>
  ),
}));

// Mock ToolCallCard — expose timestamps as data attrs for passthrough assertions
vi.mock('../../tools/ToolCallCard', () => ({
  ToolCallCard: ({
    toolCall,
  }: {
    toolCall: { toolName: string; startedAt?: number; completedAt?: number };
  }) => (
    <div
      data-testid="tool-call-card"
      data-started-at={toolCall.startedAt ?? ''}
      data-completed-at={toolCall.completedAt ?? ''}
    >
      {toolCall.toolName}
    </div>
  ),
}));

// Mock the Ask family — the three prompts and the receipt row the transcript
// composes. One slice now, so one mock.
//
// `ApprovalPrompt` exposes `allowsDenyReason` as a data attribute (default
// stringified, so an omitted prop and an explicit `true` read differently) —
// the seam DOR-825's follow-up review found unwired: this component reads
// `allowsDenyReason` off `MessageContext` and must pass exactly that value
// through, never its own default.
vi.mock('@/layers/features/ask', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/features/ask')>('@/layers/features/ask');
  return {
    ...actual,
    ApprovalPrompt: ({
      toolName,
      allowsDenyReason,
    }: {
      toolName: string;
      allowsDenyReason?: boolean;
    }) => (
      <div data-testid="tool-approval" data-allows-deny-reason={String(allowsDenyReason)}>
        {toolName}
      </div>
    ),
    QuestionPrompt: () => <div data-testid="question-prompt" />,
  };
});

// Mock the approvals feature: ApprovalCard drives real decision mutations and
// needs the query/transport providers, none of which this file is about. The
// stub exposes the approval it was handed, which is the link under test.
vi.mock('@/layers/features/approvals', () => ({
  ApprovalCard: ({ approval }: { approval: { approvalId: string; capabilityTitle: string } }) => (
    <div data-testid="approval-card" data-approval-id={approval.approvalId}>
      {approval.capabilityTitle}
    </div>
  ),
}));

// Mock MessageContext. `allowsDenyReason` is read through a hoisted mutable
// holder rather than baked into the return value, so a test can set what the
// transcript would have resolved from capabilities without re-mocking the
// whole module.
const mockContext = vi.hoisted(() => ({ allowsDenyReason: undefined as boolean | undefined }));
vi.mock('../MessageContext', () => ({
  useMessageContext: () => ({
    sessionId: 'test-session',
    isStreaming: false,
    activeToolCallId: null,
    onToolRef: undefined,
    focusedOptionIndex: -1,
    onToolDecided: undefined,
    get allowsDenyReason() {
      return mockContext.allowsDenyReason;
    },
  }),
}));

// Mock useAppStore
vi.mock('@/layers/shared/model', () => ({
  useAppStore: () => ({ expandToolCalls: false, autoHideToolCalls: false }),
}));

function makeMessage(parts: ChatMessage['parts']): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    parts: parts ?? [],
    timestamp: new Date().toISOString(),
  };
}

describe('AssistantMessageContent — multi-block part rendering', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders interleaved text and tool_call parts in order', () => {
    // Text parts key by index (`text-${i}`) — the client-only `_partId` died
    // with the legacy stream handler (spec chat-stream-reconnection, #18).
    const parts = [
      { type: 'text' as const, text: 'First block' },
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-1',
        toolName: 'Read',
        input: '{}',
        status: 'complete' as const,
      },
      { type: 'text' as const, text: 'Second block' },
    ];

    render(<AssistantMessageContent message={makeMessage(parts)} />);

    expect(screen.getByText('First block')).toBeInTheDocument();
    expect(screen.getByText('Second block')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
  });
});

describe('AssistantMessageContent — allowsDenyReason reaches a transcript-rendered approval (DOR-825)', () => {
  afterEach(() => {
    cleanup();
    mockContext.allowsDenyReason = undefined;
  });

  /** A pending approval NOT in the input zone — the path this file owns. */
  const pendingApprovalParts = [
    {
      type: 'tool_call' as const,
      toolCallId: 'tc-parked',
      toolName: 'Bash',
      input: '{}',
      status: 'pending' as const,
      interactiveType: 'approval' as const,
    },
  ];

  it('passes the runtime-resolved allowsDenyReason through, not the prop default', () => {
    // The bug: this render path used to read nothing from context, so
    // `ApprovalPrompt`'s own `= true` default always won — an OpenCode
    // session (denyReason: false) still offered a reason field on a parked
    // or batched approval rendered directly in the transcript.
    mockContext.allowsDenyReason = false;
    render(<AssistantMessageContent message={makeMessage(pendingApprovalParts)} />);

    expect(screen.getByTestId('tool-approval')).toHaveAttribute('data-allows-deny-reason', 'false');
  });

  it('passes true through when the runtime has the channel', () => {
    mockContext.allowsDenyReason = true;
    render(<AssistantMessageContent message={makeMessage(pendingApprovalParts)} />);

    expect(screen.getByTestId('tool-approval')).toHaveAttribute('data-allows-deny-reason', 'true');
  });
});

describe('AssistantMessageContent — compaction & local-command parts (DOR-118)', () => {
  afterEach(() => {
    cleanup();
  });

  it('dispatches a compact_boundary part to the compaction row', () => {
    const parts = [
      {
        type: 'compact_boundary' as const,
        trigger: 'manual' as const,
        preTokens: 52000,
        postTokens: 8000,
      },
    ];
    render(<AssistantMessageContent message={makeMessage(parts)} />);
    expect(screen.getByTestId('compact-boundary-row')).toBeInTheDocument();
    expect(screen.getByText('Compacted context · 52.0k → 8.0k tokens')).toBeInTheDocument();
  });
});

// DOR-963 shipped the projection of an agent's held approval into a
// `capability_approval` part, and DOR-987 found the render branch that consumes
// it had no test at all — the last unpinned link in the chain from the held tool
// call to something a person can click.
describe('AssistantMessageContent — inline capability approval', () => {
  afterEach(() => {
    cleanup();
  });

  const HELD_APPROVAL = {
    approvalId: 'appr-1',
    capabilityId: 'mcp.add',
    capabilityTitle: 'Add an MCP server',
    tier: 'destructive' as const,
    summary: 'Prober wants to run "Add an MCP server"',
    hasAgentPath: true,
    requestedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T02:00:00.000Z',
  };

  it('renders a live capability_approval part as the same card the dashboard shows', () => {
    render(
      <AssistantMessageContent
        message={makeMessage([{ type: 'capability_approval' as const, approval: HELD_APPROVAL }])}
      />
    );

    const card = screen.getByTestId('approval-card');
    // The SAME approvalId, because answering inline resolves the same request.
    expect(card).toHaveAttribute('data-approval-id', 'appr-1');
    expect(screen.queryByTestId('capability-approval-timed-out')).not.toBeInTheDocument();
  });

  it('renders a TIMED-OUT part as a terminal note instead of an answerable card', () => {
    render(
      <AssistantMessageContent
        message={makeMessage([
          {
            type: 'capability_approval' as const,
            approval: HELD_APPROVAL,
            outcome: 'timeout' as const,
          },
        ])}
      />
    );

    // No buttons to press: the agent has stopped waiting, so answering here
    // would resume nothing. The note says where the request still lives.
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('capability-approval-timed-out')).toBeInTheDocument();
    expect(screen.getByText(/still in your Approvals list/)).toBeInTheDocument();
  });
});

describe('AssistantMessageContent — timestamp passthrough', () => {
  afterEach(() => {
    cleanup();
  });

  it('passes startedAt and completedAt from tool_call part to ToolCallCard', () => {
    const parts = [
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-timing',
        toolName: 'Read',
        input: '{"file":"test.ts"}',
        status: 'complete' as const,
        startedAt: 1000,
        completedAt: 2234,
      },
    ];

    const { getByTestId } = render(<AssistantMessageContent message={makeMessage(parts)} />);

    const card = getByTestId('tool-call-card');
    expect(card).toHaveAttribute('data-started-at', '1000');
    expect(card).toHaveAttribute('data-completed-at', '2234');
  });

  it('passes undefined timestamps without error', () => {
    const parts = [
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-no-timing',
        toolName: 'Bash',
        input: '{"cmd":"ls"}',
        status: 'running' as const,
      },
    ];

    const { getByTestId } = render(<AssistantMessageContent message={makeMessage(parts)} />);

    const card = getByTestId('tool-call-card');
    // When timestamps are undefined, data attrs render as empty string
    expect(card).toHaveAttribute('data-started-at', '');
    expect(card).toHaveAttribute('data-completed-at', '');
  });
});

// DOR-1004 added the `mcp_signin` branch — the last link in the chain from an
// agent asking for a sign-in to something a person can click, and the one that
// the fold tests cannot reach. `McpSigninCard` is stubbed because it drives a
// real transport-backed flow; what is under test here is that the branch exists,
// dispatches, and hands the card its part.
vi.mock('../McpSigninCard', () => ({
  McpSigninCard: ({ part }: { part: { serverName: string; flowId: string; outcome?: string } }) => (
    <div data-testid="mcp-signin-card" data-flow-id={part.flowId} data-outcome={part.outcome ?? ''}>
      {part.serverName}
    </div>
  ),
}));

describe('AssistantMessageContent — inline MCP sign-in (DOR-1004)', () => {
  afterEach(() => {
    cleanup();
  });

  const CARD = {
    type: 'mcp_signin' as const,
    serverName: 'granola',
    agentId: '01HV7KJZZZ0000000000000000',
    flowId: 'flow-1',
    authorizeUrl: 'https://mcp.test.local/authorize',
    disclosure: 'DorkOS stores the token on this machine.',
  };

  it('dispatches a live mcp_signin part to the sign-in card', () => {
    render(<AssistantMessageContent message={makeMessage([CARD])} />);

    const card = screen.getByTestId('mcp-signin-card');
    expect(card).toHaveTextContent('granola');
    expect(card).toHaveAttribute('data-flow-id', 'flow-1');
    expect(card).toHaveAttribute('data-outcome', '');
  });

  it('dispatches a settled receipt through the same branch', () => {
    render(
      <AssistantMessageContent
        message={makeMessage([{ ...CARD, outcome: 'connected' as const, toolCount: 7 }])}
      />
    );

    expect(screen.getByTestId('mcp-signin-card')).toHaveAttribute('data-outcome', 'connected');
  });

  it('renders a sign-in card beside the turn’s own text', () => {
    render(
      <AssistantMessageContent
        message={makeMessage([{ type: 'text' as const, text: 'Connecting your notes.' }, CARD])}
      />
    );

    expect(screen.getByTestId('streaming-text')).toHaveTextContent('Connecting your notes.');
    expect(screen.getByTestId('mcp-signin-card')).toBeInTheDocument();
  });
});

describe('AssistantMessageContent — error parts keep the server-authored message', () => {
  it('shows an execution_error message instead of generic category copy', () => {
    // The inline path passes no `subtext`, so the model-unavailable remedy
    // the server authored used to be replaced by "An error occurred during
    // execution." before it reached the screen.
    render(
      <AssistantMessageContent
        message={makeMessage([
          {
            type: 'error' as const,
            message: "That model isn't available. Pick another one from the model menu.",
            category: 'execution_error' as const,
          },
        ])}
      />
    );

    expect(
      screen.getByText("That model isn't available. Pick another one from the model menu.")
    ).toBeInTheDocument();
    expect(screen.queryByText('An error occurred during execution.')).not.toBeInTheDocument();
  });

  it('renders a URL in an error message as a real link', () => {
    render(
      <AssistantMessageContent
        message={makeMessage([
          {
            type: 'error' as const,
            message: 'Out of credits. Add more at https://openrouter.ai/settings/credits',
            category: 'execution_error' as const,
          },
        ])}
      />
    );

    expect(
      screen.getByRole('link', { name: 'https://openrouter.ai/settings/credits' })
    ).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
  });
});
