// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { createRef } from 'react';
import { ToolApproval, type ToolApprovalHandle } from '../ui/ToolApproval';

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

describe('ToolApproval', () => {
  it('renders tool name and approve/deny buttons', () => {
    render(<ToolApproval {...baseProps} />);
    expect(screen.getByText('Write')).toBeDefined();
    expect(screen.getByText('Tool approval required')).toBeDefined();
    expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /deny/i })).toBeDefined();
  });

  it('renders tool arguments display', () => {
    render(<ToolApproval {...baseProps} />);
    expect(screen.getByTestId('tool-args')).toBeDefined();
  });

  describe('isActive prop', () => {
    it('adds ring-2 class when isActive is true', () => {
      const { container } = render(<ToolApproval {...baseProps} isActive={true} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('ring-2');
      expect(wrapper.className).toContain('ring-ring/30');
    });

    it('does not have ring-2 class when isActive is false', () => {
      const { container } = render(<ToolApproval {...baseProps} isActive={false} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).not.toContain('ring-2');
    });

    it('applies opacity-60 when isActive is false and not decided', () => {
      const { container } = render(<ToolApproval {...baseProps} isActive={false} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('opacity-60');
    });

    it('does not apply opacity-60 when isActive is true', () => {
      const { container } = render(<ToolApproval {...baseProps} isActive={true} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).not.toContain('opacity-60');
    });

    it('shows Kbd hints when isActive is true', () => {
      render(<ToolApproval {...baseProps} isActive={true} />);
      // Kbd elements render as <kbd> tags
      const kbds = document.querySelectorAll('kbd');
      expect(kbds.length).toBe(2);
      expect(kbds[0].textContent).toBe('Enter');
      expect(kbds[1].textContent).toBe('Esc');
    });

    it('hides Kbd hints when isActive is false', () => {
      render(<ToolApproval {...baseProps} isActive={false} />);
      const kbds = document.querySelectorAll('kbd');
      expect(kbds.length).toBe(0);
    });
  });

  describe('imperative handle', () => {
    it('approve() calls transport.approveTool', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(mockApproveTool).toHaveBeenCalledWith('session-1', 'tc-1');
      });
    });

    it('deny() calls transport.denyTool', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.deny();

      await waitFor(() => {
        expect(mockDenyTool).toHaveBeenCalledWith('session-1', 'tc-1');
      });
    });

    it('shows "Approved" with check icon and badge after approve', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

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
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

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
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        const toolNameEl = screen.getByTestId('tool-approval-decided').querySelector('.font-mono');
        expect(toolNameEl).not.toBeNull();
        expect(toolNameEl!.textContent).toBe('Write');
        expect(toolNameEl!.className).toContain('text-3xs');
      });
    });

    it('renders Approved badge with success styling', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        const badge = screen.getByText('Approved');
        expect(badge.className).toContain('rounded-full');
        expect(badge.className).toContain('bg-status-success-bg');
        expect(badge.className).toContain('text-status-success-fg');
      });
    });

    it('renders Denied badge with error styling', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.deny();

      await waitFor(() => {
        const badge = screen.getByText('Denied');
        expect(badge.className).toContain('rounded-full');
        expect(badge.className).toContain('bg-status-error-bg');
        expect(badge.className).toContain('text-status-error-fg');
      });
    });

    it('guards against action after decided', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(screen.getByText('Approved')).toBeDefined();
      });

      // After decided, deny should not fire
      ref.current!.deny();
      expect(mockDenyTool).not.toHaveBeenCalled();
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
    async function renderAsync(props: React.ComponentProps<typeof ToolApproval>) {
      let result!: ReturnType<typeof render>;
      await act(async () => {
        result = render(<ToolApproval {...props} />);
      });
      return result;
    }

    it('renders progress bar when timeoutMs is provided', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toBeDefined();
      expect(progressBar.getAttribute('aria-valuemax')).toBe('600');
      expect(progressBar.getAttribute('aria-valuenow')).toBe('600');
    });

    it('does not render progress bar when timeoutMs is undefined', async () => {
      await renderAsync(baseProps);
      expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('does not show text countdown before warning threshold', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      // Advance to 5 minutes elapsed (5 minutes remaining — still in normal phase)
      await act(async () => vi.advanceTimersByTime(300_000));
      expect(screen.queryByText(/remaining/)).toBeNull();
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

    it('transitions to denied state when timeout expires', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      // Advance full 10 minutes
      await act(async () => vi.advanceTimersByTime(600_000));
      expect(screen.getByText(/Auto-denied/)).toBeDefined();
      expect(screen.getByText(/timed out after 10 minutes/)).toBeDefined();
      expect(screen.getByTestId('tool-approval-decided')).toBeDefined();
      expect(screen.getByTestId('tool-approval-decided').getAttribute('data-decision')).toBe('denied');
    });

    it('does not show timeout message on manual deny', async () => {
      const ref = createRef<ToolApprovalHandle>();
      await act(async () => {
        render(<ToolApproval {...baseProps} ref={ref} timeoutMs={600_000} />);
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
      const ref = createRef<ToolApprovalHandle>();
      await act(async () => {
        render(<ToolApproval {...baseProps} ref={ref} timeoutMs={600_000} />);
      });

      // Advance 5 minutes then approve manually; flush promises and microtasks via runAllTimersAsync
      await act(async () => vi.advanceTimersByTime(300_000));
      await act(async () => {
        ref.current!.approve();
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Approved')).toBeDefined();
      // No progress bar in decided state
      expect(screen.queryByRole('progressbar')).toBeNull();
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

    it('updates aria-valuenow as time passes', async () => {
      await renderAsync({ ...baseProps, timeoutMs: 600_000 });
      await act(async () => vi.advanceTimersByTime(60_000)); // 1 minute elapsed
      const progressBar = screen.getByRole('progressbar');
      expect(progressBar.getAttribute('aria-valuenow')).toBe('540');
    });
  });
});
