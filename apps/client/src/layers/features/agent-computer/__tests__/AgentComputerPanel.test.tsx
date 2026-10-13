// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComputerStatus } from '@dorkos/shared/computer-schemas';
import { AgentComputerPanel } from '../ui/AgentComputerPanel';
import { ComputerViewer } from '../ui/ComputerViewer';

const transport = vi.hoisted(() => ({
  getComputer: vi.fn(),
  createComputer: vi.fn(),
  startComputer: vi.fn(),
  stopComputer: vi.fn(),
  signInComputer: vi.fn(),
  createComputerSession: vi.fn(),
  getComputerFrame: vi.fn(),
  acquireComputerControl: vi.fn(),
  releaseComputerControl: vi.fn(),
  sendComputerInput: vi.fn(),
}));
vi.mock('@/layers/shared/model', () => ({ useTransport: () => transport }));
const ready: ComputerStatus = {
  id: 'local',
  name: 'Agent computer',
  supported: true,
  phase: 'ready',
  generation: 4,
  ready: true,
};
const frame = { dataUrl: 'data:image/png;base64,YQ==', width: 800, height: 600, generation: 4 };

function mount() {
  const onOpenSession = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rendered = render(
    <QueryClientProvider client={client}>
      <AgentComputerPanel onOpenSession={onOpenSession} />
    </QueryClientProvider>
  );
  return { ...rendered, onOpenSession, client };
}

beforeEach(() => {
  vi.resetAllMocks();
  transport.getComputer.mockResolvedValue(ready);
  transport.getComputerFrame.mockResolvedValue(frame);
  transport.acquireComputerControl.mockResolvedValue({ leaseId: 'lease', generation: 4 });
  transport.releaseComputerControl.mockResolvedValue(undefined);
  transport.sendComputerInput.mockResolvedValue(undefined);
});

describe('AgentComputerPanel', () => {
  it('creates the missing computer and shows the observed setup state', async () => {
    transport.getComputer.mockResolvedValue({ ...ready, phase: 'missing', ready: false });
    transport.createComputer.mockImplementation(async () => {
      const next = { ...ready, phase: 'provisioning', ready: false };
      transport.getComputer.mockResolvedValue(next);
      return next;
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create computer' }));
    expect(await screen.findByText('Setting up…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
  });

  it('retries owned setup after provisioning could not finish', async () => {
    transport.getComputer.mockResolvedValue({
      ...ready,
      phase: 'failed',
      ready: false,
      error: { code: 'setup-failed' },
    });
    transport.createComputer.mockResolvedValue({ ...ready, phase: 'provisioning', ready: false });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(transport.createComputer).toHaveBeenCalledTimes(1));
    expect(transport.startComputer).not.toHaveBeenCalled();
  });

  it.each(['provisioning', 'starting', 'failed', 'uncertain'] as const)(
    'lets the owner stop a computer in %s and fences repeated actions while stopping',
    async (phase) => {
      transport.getComputer.mockResolvedValue({ ...ready, phase, ready: false });
      let finishStop!: (status: ComputerStatus) => void;
      transport.stopComputer.mockImplementation(
        () =>
          new Promise<ComputerStatus>((resolve) => {
            finishStop = resolve;
          })
      );
      mount();
      const stop = await screen.findByRole('button', { name: 'Stop' });
      fireEvent.click(stop);
      expect(stop).toBeDisabled();
      fireEvent.click(stop);
      expect(transport.stopComputer).toHaveBeenCalledTimes(1);
      const stopped: ComputerStatus = { ...ready, phase: 'stopped', ready: false };
      transport.getComputer.mockResolvedValue(stopped);
      finishStop(stopped);
      await screen.findByRole('button', { name: 'Start' });
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    }
  );

  it('opens the normal session using the server-issued host anchor', async () => {
    const session = { id: 'session', cwd: '/owned/anchor', runtime: 'computer-opencode' };
    transport.createComputerSession.mockResolvedValue(session);
    const { onOpenSession } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Chat' }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(session));
  });

  it('observes without sending input and closes without stopping the computer', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const desktop = await screen.findByAltText('Live computer desktop');
    fireEvent.pointerDown(desktop, { clientX: 10, clientY: 10 });
    fireEvent.keyDown(desktop, { key: 'a' });
    expect(transport.sendComputerInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close view' }));
    expect(screen.queryByAltText('Live computer desktop')).not.toBeInTheDocument();
    expect(transport.stopComputer).not.toHaveBeenCalled();
  });

  it('scopes keyboard input to the live lease and stops input after returning control', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const desktop = await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    fireEvent.keyDown(desktop, { key: 'a' });
    await waitFor(() =>
      expect(transport.sendComputerInput).toHaveBeenCalledWith({
        leaseId: 'lease',
        generation: 4,
        kind: 'key',
        key: 'a',
        action: 'down',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Return control' }));
    await screen.findByText('Watching');
    fireEvent.keyDown(desktop, { key: 'b' });
    expect(transport.sendComputerInput).toHaveBeenCalledTimes(1);
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('lease');
  });

  it('keeps the focused takeover button enabled while acquiring and preserves the returned lease', async () => {
    let finish!: (lease: { leaseId: string; generation: number }) => void;
    transport.acquireComputerControl.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByAltText('Live computer desktop');
    const takeOver = screen.getByRole('button', { name: 'Take over' });
    takeOver.focus();
    fireEvent.click(takeOver);
    expect(takeOver).toHaveFocus();
    expect(takeOver).not.toBeDisabled();
    expect(takeOver).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(takeOver);
    expect(transport.acquireComputerControl).toHaveBeenCalledTimes(1);
    await act(async () => finish({ leaseId: 'lease', generation: 4 }));
    await screen.findByText('You have control');
    expect(screen.getByRole('application')).toHaveFocus();
    expect(transport.releaseComputerControl).not.toHaveBeenCalled();
  });

  it('ignores a watching frame requested before a successful takeover', async () => {
    let finishFrame!: (value: typeof frame & { controlledByYou: boolean }) => void;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByAltText('Live computer desktop');
    transport.getComputerFrame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFrame = resolve;
        })
    );
    await waitFor(() => expect(finishFrame).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    await act(async () => finishFrame({ ...frame, controlledByYou: false }));
    expect(screen.getByText('You have control')).toBeInTheDocument();
    expect(transport.releaseComputerControl).not.toHaveBeenCalled();
  });

  it('rejects a lease for another generation', async () => {
    transport.acquireComputerControl.mockResolvedValue({ leaseId: 'stale', generation: 3 });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const desktop = await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(transport.releaseComputerControl).toHaveBeenCalledWith('stale'));
    fireEvent.keyDown(desktop, { key: 'a' });
    expect(transport.sendComputerInput).not.toHaveBeenCalled();
  });

  it('drops queued input when the live lease is revoked', async () => {
    let rejectFirst!: (error: Error) => void;
    transport.sendComputerInput.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const desktop = await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    fireEvent.keyDown(desktop, { key: 'a' });
    fireEvent.keyDown(desktop, { key: 'b' });
    await waitFor(() => expect(transport.sendComputerInput).toHaveBeenCalledTimes(1));
    rejectFirst(new Error('lease revoked'));
    await screen.findByText('Watching');
    expect(transport.sendComputerInput).toHaveBeenCalledTimes(1);
  });

  it('drops control and queued input when the next frame reports another controller', async () => {
    let finishInput!: () => void;
    transport.sendComputerInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInput = resolve;
        })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const desktop = await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    fireEvent.change(screen.getByRole('textbox', { name: 'Type on computer' }), {
      target: { value: 'private draft' },
    });
    fireEvent.keyDown(desktop, { key: 'a' });
    fireEvent.keyDown(desktop, { key: 'b' });
    await waitFor(() => expect(transport.sendComputerInput).toHaveBeenCalledTimes(1));
    transport.getComputerFrame.mockResolvedValue({ ...frame, controlledByYou: false });
    await screen.findByText('Watching');
    expect(screen.queryByRole('textbox', { name: 'Type on computer' })).not.toBeInTheDocument();
    finishInput();
    fireEvent.keyDown(desktop, { key: 'c' });
    await waitFor(() => expect(transport.sendComputerInput).toHaveBeenCalledTimes(1));
    expect(transport.releaseComputerControl).not.toHaveBeenCalled();
    transport.getComputerFrame.mockResolvedValue({ ...frame, controlledByYou: true });
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(await screen.findByRole('textbox', { name: 'Type on computer' })).toHaveValue('');
  });

  it('clears the old display and lease when the same viewer receives a new generation', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<ComputerViewer generation={4} onClose={onClose} />);
    const desktop = await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    transport.getComputerFrame.mockImplementation(() => new Promise(() => {}));
    rerender(<ComputerViewer generation={5} onClose={onClose} />);
    await screen.findByText('Watching');
    expect(screen.queryByAltText('Live computer desktop')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Type on computer' })).not.toBeInTheDocument();
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('lease');
    fireEvent.keyDown(desktop, { key: 'a' });
    expect(transport.sendComputerInput).not.toHaveBeenCalled();
  });

  it('releases control when the viewer unmounts', async () => {
    const { unmount } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    unmount();
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('lease');
    expect(transport.stopComputer).not.toHaveBeenCalled();
  });

  it('releases a takeover that finishes after the viewer closes', async () => {
    let finish!: (lease: { leaseId: string; generation: number }) => void;
    transport.acquireComputerControl.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close view' }));
    finish({ leaseId: 'late', generation: 4 });
    await waitFor(() => expect(transport.releaseComputerControl).toHaveBeenCalledWith('late'));
    expect(transport.sendComputerInput).not.toHaveBeenCalled();
  });

  it('provides a keyboard exit from guest control', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const desktop = await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    fireEvent.keyDown(desktop, { key: 'Escape', ctrlKey: true, shiftKey: true });
    await screen.findByText('Watching');
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('lease');
    expect(transport.sendComputerInput).not.toHaveBeenCalled();
  });

  it('lets a phone type through the same live control lease', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByAltText('Live computer desktop');
    expect(screen.queryByRole('textbox', { name: 'Type on computer' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const input = await screen.findByRole('textbox', { name: 'Type on computer' });
    fireEvent.change(input, { target: { value: 'founder@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    await waitFor(() =>
      expect(transport.sendComputerInput).toHaveBeenCalledWith({
        kind: 'text',
        text: 'founder@example.com',
        leaseId: 'lease',
        generation: 4,
      })
    );
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('retains control and focus while typing and after clearing the delivered draft', async () => {
    let finishInput!: () => void;
    transport.sendComputerInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInput = resolve;
        })
    );
    render(<ComputerViewer generation={4} onClose={vi.fn()} />);
    await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const input = await screen.findByRole('textbox', { name: 'Type on computer' });
    fireEvent.change(input, { target: { value: 'OpenAI' } });
    const type = screen.getByRole('button', { name: 'Type' });
    type.focus();
    fireEvent.click(type);
    await waitFor(() => expect(transport.sendComputerInput).toHaveBeenCalledTimes(1));
    expect(type).toHaveFocus();
    expect(type).not.toBeDisabled();
    expect(type).toHaveAttribute('aria-disabled', 'true');
    expect(type).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(type);
    expect(transport.sendComputerInput).toHaveBeenCalledTimes(1);
    await act(async () => finishInput());
    expect(input).toHaveValue('');
    expect(type).toHaveFocus();
    expect(type).not.toBeDisabled();
    expect(type).toHaveAttribute('aria-disabled', 'true');
    expect(type).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(type);
    expect(transport.sendComputerInput).toHaveBeenCalledTimes(1);
    expect(screen.getByText('You have control')).toBeInTheDocument();
    expect(transport.releaseComputerControl).not.toHaveBeenCalled();
  });

  it('retains control while Enter delivers its ordered key pair', async () => {
    render(<ComputerViewer generation={4} onClose={vi.fn()} />);
    await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    const enter = screen.getByRole('button', { name: 'Enter' });
    enter.focus();
    fireEvent.click(enter);
    await waitFor(() => expect(transport.sendComputerInput).toHaveBeenCalledTimes(2));
    expect(transport.sendComputerInput).toHaveBeenNthCalledWith(1, {
      kind: 'key',
      key: 'Enter',
      action: 'down',
      leaseId: 'lease',
      generation: 4,
    });
    expect(transport.sendComputerInput).toHaveBeenNthCalledWith(2, {
      kind: 'key',
      key: 'Enter',
      action: 'up',
      leaseId: 'lease',
      generation: 4,
    });
    expect(enter).toHaveFocus();
    expect(screen.getByText('You have control')).toBeInTheDocument();
    expect(transport.releaseComputerControl).not.toHaveBeenCalled();
  });

  it('returns held input when the browser loses focus', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    fireEvent(window, new Event('blur'));
    await screen.findByText('Watching');
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('lease');
  });

  it('does not offer start or create when resource ownership is uncertain', async () => {
    transport.getComputer.mockResolvedValue({ ...ready, phase: 'uncertain', ready: false });
    mount();
    await screen.findByText('Couldn’t confirm its state. Reconnect before continuing.');
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create computer' })).not.toBeInTheDocument();
  });
});
