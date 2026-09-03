// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { ApprovalPrompt, type ApprovalPromptHandle } from '../ui/ApprovalPrompt';

const mockApproveTool = vi.fn().mockResolvedValue(undefined);
const mockDenyTool = vi.fn().mockResolvedValue(undefined);
vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: () => ({
    approveTool: mockApproveTool,
    denyTool: mockDenyTool,
  }),
}));

// Mock ToolArgumentsDisplay to avoid deep dependency chain
vi.mock('@/layers/shared/lib/tool-arguments-formatter', () => ({
  ToolArgumentsDisplay: ({ toolName, input }: { toolName: string; input: string }) => (
    <div data-testid="tool-args">
      {toolName}: {input}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  mockApproveTool.mockClear();
  mockDenyTool.mockClear();
});

const baseProps = {
  sessionId: 'session-1',
  toolCallId: 'tc-1',
  toolName: 'Write',
  input: '{"file_path": "/tmp/test.txt"}',
};

describe('ApprovalPrompt', () => {
  it('renders tool name and approve/deny buttons', () => {
    render(<ApprovalPrompt {...baseProps} />);
    expect(screen.getByText('Write test.txt')).toBeDefined();
    expect(screen.getByText('Tool approval required')).toBeDefined();
    expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /deny/i })).toBeDefined();
  });

  it('renders tool arguments display', () => {
    render(<ApprovalPrompt {...baseProps} />);
    expect(screen.getByTestId('tool-args')).toBeDefined();
  });

  describe('deny reason', () => {
    it('stays out of the way until asked for', () => {
      // The fast path is read the command, allow or deny. The field is an
      // affordance for the times you want to say more, not a step in the flow.
      render(<ApprovalPrompt {...baseProps} />);
      expect(screen.queryByLabelText('Reason for denying')).toBeNull();
      expect(screen.getByRole('button', { name: /add a reason/i })).toBeDefined();
    });

    it('sends what was typed with the denial', async () => {
      render(<ApprovalPrompt {...baseProps} />);
      fireEvent.click(screen.getByRole('button', { name: /add a reason/i }));

      const field = screen.getByLabelText('Reason for denying');
      fireEvent.change(field, { target: { value: 'Write it under tmp/ instead' } });
      fireEvent.click(screen.getByRole('button', { name: /^deny/i }));

      await waitFor(() => {
        expect(mockDenyTool).toHaveBeenCalledWith(
          'session-1',
          'tc-1',
          'Write it under tmp/ instead'
        );
      });
    });

    it('denies on Enter in the field — never approves', async () => {
      // Enter inside the card normally means Approve. From inside this field it
      // must mean "send this refusal", or the reason someone typed would allow
      // the call they were refusing.
      render(<ApprovalPrompt {...baseProps} isActive />);
      fireEvent.click(screen.getByRole('button', { name: /add a reason/i }));

      const field = screen.getByLabelText('Reason for denying');
      fireEvent.change(field, { target: { value: 'not that path' } });
      fireEvent.keyDown(field, { key: 'Enter' });

      await waitFor(() => {
        expect(mockDenyTool).toHaveBeenCalledWith('session-1', 'tc-1', 'not that path');
      });
      expect(mockApproveTool).not.toHaveBeenCalled();
    });

    it('sends nothing when the field was opened and left blank', async () => {
      render(<ApprovalPrompt {...baseProps} />);
      fireEvent.click(screen.getByRole('button', { name: /add a reason/i }));
      fireEvent.change(screen.getByLabelText('Reason for denying'), { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: /^deny/i }));

      await waitFor(() => {
        expect(mockDenyTool).toHaveBeenCalledWith('session-1', 'tc-1', undefined);
      });
    });

    it('hides the affordance entirely on a runtime with no channel for it (DOR-825)', () => {
      // OpenCode's respond endpoint takes no free text, so a reason typed here
      // would go nowhere — the field itself should not be offered, not merely
      // fail to send.
      render(<ApprovalPrompt {...baseProps} allowsDenyReason={false} />);
      expect(screen.queryByRole('button', { name: /add a reason/i })).toBeNull();
      expect(screen.queryByLabelText('Reason for denying')).toBeNull();
    });

    it('still denies cleanly, with no reason, when the affordance is hidden', async () => {
      render(<ApprovalPrompt {...baseProps} allowsDenyReason={false} />);
      fireEvent.click(screen.getByRole('button', { name: /^deny/i }));

      await waitFor(() => {
        expect(mockDenyTool).toHaveBeenCalledWith('session-1', 'tc-1', undefined);
      });
    });
  });

  describe('isActive prop', () => {
    it('adds ring-2 class when isActive is true', () => {
      const { container } = render(<ApprovalPrompt {...baseProps} isActive={true} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('ring-2');
      expect(wrapper.className).toContain('ring-ring/30');
    });

    it('does not have ring-2 class when isActive is false', () => {
      const { container } = render(<ApprovalPrompt {...baseProps} isActive={false} />);
      const wrapper = container.firstElementChild as HTMLElement;
      // The ACTIVE ring, specifically. The card also carries a `focus-visible:`
      // twin of it — the design system's parity rule — which contains the same
      // `ring-2` substring and is not what this case is about.
      expect(wrapper.className).not.toContain('ring-ring/30');
    });

    it('applies opacity-60 when isActive is false and not decided', () => {
      const { container } = render(<ApprovalPrompt {...baseProps} isActive={false} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('opacity-60');
    });

    it('does not apply opacity-60 when isActive is true', () => {
      const { container } = render(<ApprovalPrompt {...baseProps} isActive={true} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).not.toContain('opacity-60');
    });

    it('shows Kbd hints when isActive is true', () => {
      render(<ApprovalPrompt {...baseProps} isActive={true} />);
      // Kbd elements render as <kbd> tags
      const kbds = document.querySelectorAll('kbd');
      expect(kbds.length).toBe(2);
      expect(kbds[0].textContent).toBe('Enter');
      expect(kbds[1].textContent).toBe('Esc');
    });

    it('hides Kbd hints when isActive is false', () => {
      render(<ApprovalPrompt {...baseProps} isActive={false} />);
      const kbds = document.querySelectorAll('kbd');
      expect(kbds.length).toBe(0);
    });
  });

  describe('imperative handle', () => {
    it('approve() calls transport.approveTool', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(mockApproveTool).toHaveBeenCalledWith('session-1', 'tc-1');
      });
    });

    it('deny() calls transport.denyTool', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.deny();

      await waitFor(() => {
        // The third argument is the optional reason; nobody typed one here.
        expect(mockDenyTool).toHaveBeenCalledWith('session-1', 'tc-1', undefined);
      });
    });

    it('shows "Approved" with check icon and badge after approve', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(screen.getByText('Approved')).toBeDefined();
        // Check icon should be present with success color
        const container = screen.getByTestId('tool-approval-decided');
        const svg = container.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg!.classList.toString()).toContain('text-status-success');
        // Container should have neutral background with shadow
        expect(container.className).toContain('bg-muted/50');
        expect(container.className).toContain('shadow-msg-tool');
      });
    });

    it('shows "Denied" with X icon and badge after deny', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.deny();

      await waitFor(() => {
        expect(screen.getByText('Denied')).toBeDefined();
        // X icon should be present with error color
        const container = screen.getByTestId('tool-approval-decided');
        const svg = container.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg!.classList.toString()).toContain('text-status-error');
        // Container should have neutral background with shadow
        expect(container.className).toContain('bg-muted/50');
        expect(container.className).toContain('shadow-msg-tool');
      });
    });

    it('renders tool name in mono font in decided state', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        const toolNameEl = screen.getByTestId('tool-approval-decided').querySelector('.font-mono');
        expect(toolNameEl).not.toBeNull();
        expect(toolNameEl!.textContent).toBe('Write test.txt');
        expect(toolNameEl!.className).toContain('text-3xs');
      });
    });

    it('renders Approved badge with success styling', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        const badge = screen.getByText('Approved');
        expect(badge.className).toContain('rounded-full');
        expect(badge.className).toContain('bg-status-success-bg');
        expect(badge.className).toContain('text-status-success-fg');
      });
    });

    it('renders Denied badge with error styling', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.deny();

      await waitFor(() => {
        const badge = screen.getByText('Denied');
        expect(badge.className).toContain('rounded-full');
        expect(badge.className).toContain('bg-status-error-bg');
        expect(badge.className).toContain('text-status-error-fg');
      });
    });

    it('guards against action after decided', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(screen.getByText('Approved')).toBeDefined();
      });

      // After decided, deny should not fire
      ref.current!.deny();
      expect(mockDenyTool).not.toHaveBeenCalled();
    });
  });

  describe('stale answer (409 INTERACTION_ALREADY_RESOLVED) is a benign no-op', () => {
    // When another surface already answered this interaction (recovery re-emit,
    // a backgrounded tab, a Slack click), the server resolved+deleted the entry,
    // so this card's approve/deny lands as a 409. fetchJSON throws an Error with
    // `code === 'INTERACTION_ALREADY_RESOLVED'`. The card must treat that as
    // "already handled" — transition to the resolved state, surface NO error
    // toast — because the authoritative tool_result will clear it anyway.

    /** Build the Error shape fetchJSON throws for a 409 with a JSON `code`. */
    function alreadyResolvedError(): Error & { code: string; status: number } {
      const err = new Error('Interaction already resolved') as Error & {
        code: string;
        status: number;
      };
      err.code = 'INTERACTION_ALREADY_RESOLVED';
      err.status = 409;
      return err;
    }

    it('approve resolving with 409 shows Approved and no error message', async () => {
      // Purpose: benign UX on a raced approve. A duplicate/stale approve must not
      // dead-end the card in an error state; it resolves like a normal approve.
      mockApproveTool.mockRejectedValueOnce(alreadyResolvedError());
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(screen.getByText('Approved')).toBeDefined();
      });
      // No user-facing error surfaced for the raced answer.
      expect(screen.queryByText(/try again/)).toBeNull();
      expect(screen.queryByText(/failed/i)).toBeNull();
    });

    it('deny resolving with 409 shows Denied and no error message', async () => {
      // Purpose: benign UX on a raced deny. Mirror of the approve case for the
      // deny path.
      mockDenyTool.mockRejectedValueOnce(alreadyResolvedError());
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.deny();

      await waitFor(() => {
        expect(screen.getByText('Denied')).toBeDefined();
      });
      expect(screen.queryByText(/try again/)).toBeNull();
      expect(screen.queryByText(/failed/i)).toBeNull();
    });

    it('a genuine (non-409) failure still surfaces an error and does not resolve', async () => {
      // Purpose: the 409 swallow must be narrow — a real failure (network, 500)
      // still shows the retry affordance, so we are not masking actual errors.
      mockApproveTool.mockRejectedValueOnce(new Error('HTTP 500'));
      const ref = createRef<ApprovalPromptHandle>();
      render(<ApprovalPrompt {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(screen.getByText(/Approval request failed/)).toBeDefined();
      });
      expect(screen.queryByText('Approved')).toBeNull();
    });
  });

  describe('countdown timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Helper: render inside async act so React flushes effects with fake timers active.
    async function renderAsync(props: React.ComponentProps<typeof ApprovalPrompt>) {
      let result!: ReturnType<typeof render>;
      await act(async () => {
        result = render(<ApprovalPrompt {...props} />);
      });
      return result;
    }

    it('draws the countdown, with the bar as decoration and the words as the reading', async () => {
      // The bar is `aria-hidden` on purpose (spec §4.4): a progress element that
      // announced itself every second is the siren the design system forbids, so
      // the ACCESSIBLE countdown is the text beside it.
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      const countdown = document.querySelector('[data-slot="ask-countdown"]') as HTMLElement;
      expect(countdown).not.toBeNull();
      expect(countdown.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(countdown.textContent).toBe('10:00 remaining');
    });

    it('anchors the draining bar to the time actually left, not to a fresh start', async () => {
      // DOR-810. The bar is a CSS animation over the FULL budget, so a card
      // mounted mid-wait — a reload, a second window, a card scrolled back
      // into view — restarted it from full and drew a nearly-full bar over an
      // ask with a minute left. A negative delay of the elapsed time seeks the
      // animation to where the clock actually is.
      await renderAsync({ ...baseProps, timeoutMs: 600_000, approvalRemainingMs: 61_000 });
      const countdown = document.querySelector('[data-slot="ask-countdown"]') as HTMLElement;
      const drain = countdown.querySelector('[aria-hidden="true"] > div') as HTMLElement;
      expect(drain.style.animationDuration).toBe('600000ms');
      expect(drain.style.animationDelay).toBe('-539000ms');
      // And the words agree with the bar, rather than contradicting it.
      expect(countdown.textContent).toBe('1:01 remaining');
    });

    it('starts the bar at full when the ask is brand new', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      const drain = document.querySelector(
        '[data-slot="ask-countdown"] [aria-hidden="true"] > div'
      ) as HTMLElement;
      expect(drain.style.animationDelay).toBe('0ms');
    });

    it('draws no countdown at all when the ask has no deadline', async () => {
      await renderAsync(baseProps);
      expect(document.querySelector('[data-slot="ask-countdown"]')).toBeNull();
    });

    it('shows the time left from the start, in neutral colour until two minutes', async () => {
      // Changed deliberately in P3: the words are the accessible countdown, so
      // withholding them until two minutes left a screen-reader user with
      // nothing at all for eight of the ten minutes. The THRESHOLDS still mean
      // something — they decide the colour.
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      await act(async () => vi.advanceTimersByTime(300_000));
      const words = screen.getByText('5:00 remaining');
      expect(words.className).toContain('text-muted-foreground');
    });

    it('shows text countdown at warning threshold (2 minutes remaining)', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      // Advance to 8 minutes elapsed (2 minutes remaining)
      await act(async () => vi.advanceTimersByTime(480_000));
      // Both the visible countdown span and the sr-only live region contain "remaining"
      const elements = screen.getAllByText(/remaining/);
      // The visible countdown element should be the non-sr-only span
      const visibleCountdown = elements.find((el) => !el.className.includes('sr-only'));
      expect(visibleCountdown).toBeDefined();
      expect(visibleCountdown!.className).toContain('text-status-warning');
    });

    it('shows countdown with correct format at 1:30 remaining', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      // Advance to 8m30s elapsed (1:30 remaining)
      await act(async () => vi.advanceTimersByTime(510_000));
      expect(screen.getByText('1:30 remaining')).toBeDefined();
    });

    it('applies urgent styling at 1 minute remaining', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      // Advance to 9 minutes elapsed (1 minute remaining)
      await act(async () => vi.advanceTimersByTime(540_000));
      const elements = screen.getAllByText(/remaining/);
      const countdownEl = elements.find((el) => !el.className.includes('sr-only'));
      expect(countdownEl).toBeDefined();
      expect(countdownEl!.className).toContain('text-status-error');
    });

    it('parks when the countdown runs out, keeping both answers live', async () => {
      // Spec `ask-parks-on-timeout`: the agent holds the tool call past ten
      // minutes, so this card must not decide for it. Before this it collapsed
      // to "Auto-denied" while the agent was still waiting, and the person who
      // came back found no buttons and a refusal they never gave.
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      // Advance full 10 minutes
      await act(async () => vi.advanceTimersByTime(600_000));

      expect(screen.queryByTestId('tool-approval-decided')).toBeNull();
      expect(screen.getByText('waiting for you')).toBeDefined();
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /deny/i })).toBeDefined();
      // No draining bar over a wait that is not counting down.
      expect(document.querySelector('[data-slot="ask-countdown"] [aria-hidden]')).toBeNull();
    });

    it('a card recovered MID-PARK says waiting, and never counts the ceiling down', async () => {
      // The blocker this test exists for: a parked DTO ships no `timeoutMs` and
      // a remainder to the four-hour ceiling, while the replayed ask still
      // carries the ten-minute budget. Read as a countdown, that rendered
      // "228:59 remaining" with a draining bar over a prompt the agent was
      // quietly holding. Reachable by any reload during a park.
      await renderAsync({
        ...baseProps,
        timeoutMs: 600_000,
        approvalRemainingMs: 4 * 60 * 60_000 - 11 * 60_000,
        approvalParked: true,
      });

      expect(screen.getByText('waiting for you')).toBeDefined();
      expect(screen.queryByText(/remaining/)).toBeNull();
      expect(document.querySelector('[data-slot="ask-countdown"] [aria-hidden]')).toBeNull();
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();

      // And it stays that way: no interval is ticking a ceiling down behind it.
      await act(async () => vi.advanceTimersByTime(120_000));
      expect(screen.getByText('waiting for you')).toBeDefined();
      expect(screen.queryByText(/remaining/)).toBeNull();
    });

    it('says waiting on a parked card that carries no budget at all', async () => {
      // The other recovery shape: the turn was cleared, so the card is built
      // from the DTO alone and has no `timeoutMs` to gate the line on.
      await renderAsync({
        ...baseProps,
        approvalRemainingMs: 4 * 60 * 60_000 - 11 * 60_000,
        approvalParked: true,
      });

      expect(screen.getByText('waiting for you')).toBeDefined();
      expect(document.querySelector('[data-slot="ask-countdown"] [aria-hidden]')).toBeNull();
    });

    it('a recovered card whose remainder has run out reads as waiting, not as gone', async () => {
      // A card recovered on reconnect (Path A pull / Path B re-emit) carries a
      // server-authoritative `approvalRemainingMs`. The server never lists a
      // prompt whose remainder is out, so a countdown that reaches zero here
      // means the agent parked on it — it is still answerable, and answering it
      // still resolves the held tool call.
      await renderAsync({ ...baseProps, timeoutMs: 600_000, approvalRemainingMs: 500 });

      // Approve/Deny are live before the (tiny) remaining window elapses.
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();

      // Drain the near-zero remaining window plus an interval tick.
      await act(async () => vi.advanceTimersByTime(1_000));

      expect(screen.queryByTestId('tool-approval-decided')).toBeNull();
      expect(screen.getByText('waiting for you')).toBeDefined();
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /deny/i })).toBeDefined();
      // Nothing was answered on anybody's behalf.
      expect(mockApproveTool).not.toHaveBeenCalled();
      expect(mockDenyTool).not.toHaveBeenCalled();
    });

    it('does not show timeout message on manual deny', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      await act(async () => {
        render(<ApprovalPrompt {...baseProps} ref={ref} timeoutMs={600_000} />);
      });

      // Advance 5 minutes then deny manually; flush promises and microtasks via runAllTimersAsync
      await act(async () => vi.advanceTimersByTime(300_000));
      await act(async () => {
        ref.current!.deny();
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Denied')).toBeDefined();
      expect(screen.queryByText(/Auto-denied/)).toBeNull();
      expect(screen.queryByText(/timed out/)).toBeNull();
    });

    it('approve works during countdown and stops timer display', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      await act(async () => {
        render(<ApprovalPrompt {...baseProps} ref={ref} timeoutMs={600_000} />);
      });

      // Advance 5 minutes then approve manually; flush promises and microtasks via runAllTimersAsync
      await act(async () => vi.advanceTimersByTime(300_000));
      await act(async () => {
        ref.current!.approve();
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Approved')).toBeDefined();
      // No countdown in the decided state
      expect(document.querySelector('[data-slot="ask-countdown"]')).toBeNull();
      // No timeout message
      expect(screen.queryByText(/Auto-denied/)).toBeNull();
    });

    it('announces at warning threshold for screen readers', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      await act(async () => vi.advanceTimersByTime(480_000)); // 8 minutes elapsed, 2 minutes remaining
      const liveRegion = screen.getByRole('status');
      expect(liveRegion.textContent).toBe('Tool approval required. 2 minutes remaining.');
    });

    it('announces at urgent threshold for screen readers', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      await act(async () => vi.advanceTimersByTime(540_000)); // 9 minutes elapsed, 1 minute remaining
      const liveRegion = screen.getByRole('status');
      expect(liveRegion.textContent).toBe('Urgent: 1 minute to approve or deny.');
    });

    it('counts the words down as time passes', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      await act(async () => vi.advanceTimersByTime(60_000)); // 1 minute elapsed
      expect(screen.getByText('9:00 remaining')).toBeDefined();
    });
  });

  describe('friendly tool name formatting', () => {
    it('renders friendly label for MCP tool names with server badge', () => {
      render(
        <ApprovalPrompt
          {...baseProps}
          toolName="mcp__slack__send_message"
          input='{"channel": "#general"}'
        />
      );
      expect(screen.getByText('Slack')).toBeDefined();
      expect(screen.getByText('Send Message')).toBeDefined();
    });

    it('suppresses badge for DorkOS tools but shows friendly label', () => {
      render(
        <ApprovalPrompt {...baseProps} toolName="mcp__dorkos__binding_list_sessions" input="{}" />
      );
      expect(screen.queryByText('DorkOS')).toBeNull();
      expect(screen.getByText('Binding List Sessions')).toBeDefined();
    });

    it('shows friendly label in decided state for MCP tools', async () => {
      const ref = createRef<ApprovalPromptHandle>();
      render(
        <ApprovalPrompt
          {...baseProps}
          toolName="mcp__slack__send_message"
          input='{"channel": "#general"}'
          ref={ref}
        />
      );

      ref.current!.approve();

      await waitFor(() => {
        const toolNameEl = screen.getByTestId('tool-approval-decided').querySelector('.font-mono');
        expect(toolNameEl).not.toBeNull();
        expect(toolNameEl!.textContent).toBe('Send Message');
      });
    });
  });
});

describe('what "Always Allow" says it grants (DOR-1462)', () => {
  it('names the operator’s global settings when the grant reaches them', async () => {
    // The whole point of the ticket: this click forwards suggestions the CLI
    // writes to ~/.claude/settings.json, so the button has to say so BEFORE it
    // is pressed — and it still has to be the button that does it.
    render(
      <ApprovalPrompt {...baseProps} approvalHasSuggestions approvalAlwaysAllowScope="user" />
    );

    const button = screen.getByRole('button', { name: /always allow/i });
    expect(button.textContent).toContain('all your Claude sessions');
    // And in the ACCESSIBLE name, not only on screen: the reach is half of what
    // this button does, so a screen-reader user must hear it before the press —
    // as one deterministic sentence, not whatever the engine assembles from the
    // children.
    expect(screen.getByRole('button', { name: 'Always Allow, all your Claude sessions' })).toBe(
      button
    );

    fireEvent.click(button);
    await waitFor(() => {
      expect(mockApproveTool).toHaveBeenCalledWith('session-1', 'tc-1', true);
    });
  });

  it('names this project for a repo-scoped grant', () => {
    render(
      <ApprovalPrompt {...baseProps} approvalHasSuggestions approvalAlwaysAllowScope="project" />
    );
    expect(screen.getByRole('button', { name: /always allow/i }).textContent).toContain(
      'this project'
    );
  });

  it('names this session for a grant that dies with the conversation', () => {
    render(
      <ApprovalPrompt {...baseProps} approvalHasSuggestions approvalAlwaysAllowScope="session" />
    );
    expect(screen.getByRole('button', { name: /always allow/i }).textContent).toContain(
      'this session'
    );
  });

  it('claims no scope when the server named none', () => {
    // A runtime with nothing to say leaves the button reading exactly as it
    // always did, rather than guessing at a promise nobody made.
    render(<ApprovalPrompt {...baseProps} approvalHasSuggestions />);
    const button = screen.getByRole('button', { name: 'Always Allow' });
    expect(button.textContent).not.toContain('this session');
    expect(button.textContent).not.toContain('this project');
    expect(button.textContent).not.toContain('all your Claude sessions');
  });

  it('draws no scope where there is no button', () => {
    render(<ApprovalPrompt {...baseProps} approvalAlwaysAllowScope="user" />);
    expect(screen.queryByRole('button', { name: /always allow/i })).toBeNull();
    expect(screen.queryByText(/all your Claude sessions/)).toBeNull();
  });
});
