// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { ToolApproval, type ToolApprovalHandle } from '../ui/ToolApproval';

vi.mock('motion/react', () => ({
  motion: new Proxy({}, { get: (_, tag) => tag }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
    <div data-testid="tool-args">{toolName}: {input}</div>
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
      expect(wrapper.className).toContain('ring-amber-500/30');
    });

    it('does not have ring-2 class when isActive is false', () => {
      const { container } = render(<ToolApproval {...baseProps} isActive={false} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).not.toContain('ring-2');
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

    it('shows "Approved" after approve', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.approve();

      await waitFor(() => {
        expect(screen.getByText('Approved')).toBeDefined();
      });
    });

    it('shows "Denied" after deny', async () => {
      const ref = createRef<ToolApprovalHandle>();
      render(<ToolApproval {...baseProps} ref={ref} />);

      ref.current!.deny();

      await waitFor(() => {
        expect(screen.getByText('Denied')).toBeDefined();
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
});
