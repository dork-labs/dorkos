// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ComputerStatus } from '@dorkos/shared/computer-schemas';
import { TransportProvider, useAppStore, type PipContent } from '@/layers/shared/model';
import { COMPUTER_QUERY_KEY } from '@/layers/entities/computer';
import { ComputerPanelView, ComputerPipView } from '../ui/ComputerResourceView';

type ComputerContent = Extract<PipContent, { kind: 'computer' }>;
const ready: ComputerStatus = {
  id: 'local',
  name: 'Agent computer',
  supported: true,
  phase: 'ready',
  generation: 4,
  ready: true,
  cwd: '/agents/original/workspace',
};
const descriptor: ComputerContent = {
  kind: 'computer',
  computerId: 'local',
  generation: 4,
  cwd: '/agents/original/workspace',
  agentPath: '/agents/original',
  title: 'Agent computer',
};
const frame = { dataUrl: 'data:image/png;base64,YQ==', width: 800, height: 600, generation: 4 };
const clients: QueryClient[] = [];

/** Render both real presenters using the real ephemeral PiP store. */
function Views({ panel = true }: { panel?: boolean }) {
  const content = useAppStore((state) => state.pipContent);
  return (
    <>
      {panel && <ComputerPanelView />}
      {content?.kind === 'computer' && <ComputerPipView content={content} />}
    </>
  );
}

function mount(panel = true) {
  const transport = createMockTransport({
    getComputer: vi.fn().mockResolvedValue(ready),
    getComputerFrame: vi.fn().mockResolvedValue(frame),
    acquireComputerControl: vi.fn().mockResolvedValue({ leaseId: 'lease', generation: 4 }),
    releaseComputerControl: vi.fn().mockResolvedValue(undefined),
    sendComputerInput: vi.fn().mockResolvedValue(undefined),
    stopComputer: vi.fn(),
    startComputer: vi.fn(),
    createComputer: vi.fn(),
    createComputerSession: vi.fn(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const result = render(
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>
        <Views panel={panel} />
      </QueryClientProvider>
    </TransportProvider>
  );
  return { ...result, transport, client };
}

function expectNoLifecycle(transport: ReturnType<typeof createMockTransport>) {
  expect(transport.stopComputer).not.toHaveBeenCalled();
  expect(transport.startComputer).not.toHaveBeenCalled();
  expect(transport.createComputer).not.toHaveBeenCalled();
  expect(transport.createComputerSession).not.toHaveBeenCalled();
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    pipContent: null,
    pipMinimized: false,
    selectedCwd: '/agents/original/workspace',
    sessionId: 'original-chat',
    explicitAgentPath: null,
    requestedRightPanel: null,
    rightPanelOpen: false,
    rightPanelLayoutKey: null,
    activeRightPanelTab: null,
  });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe('Computer resource panel and PiP', () => {
  it('moves observation into PiP and restores the panel without stopping or creating resources', async () => {
    const { transport } = mount();
    await screen.findByAltText('Live computer desktop');
    expect(transport.acquireComputerControl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pop computer out' }));
    expect(useAppStore.getState().pipContent).toEqual(descriptor);
    expect(await screen.findByText('Viewing in PiP.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pop computer out' })).not.toBeInTheDocument();
    expect(screen.getAllByAltText('Live computer desktop')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Bring back' }));
    expect(useAppStore.getState().pipContent).toBeNull();
    await screen.findByRole('button', { name: 'Pop computer out' });
    expect(screen.queryByText('Viewing in PiP.')).not.toBeInTheDocument();
    expectNoLifecycle(transport);
  });

  it('keeps the pinned computer across another chat and returns only the explicit panel agent', async () => {
    useAppStore.getState().openPip(descriptor);
    const { transport } = mount(false);
    await screen.findByAltText('Live computer desktop');
    act(() =>
      useAppStore.setState({ selectedCwd: '/agents/other/workspace', sessionId: 'other-chat' })
    );
    expect(screen.getByAltText('Live computer desktop')).toBeInTheDocument();
    expect(useAppStore.getState().pipContent).toEqual(descriptor);
    fireEvent.click(screen.getByRole('button', { name: 'Return computer to panel' }));
    const state = useAppStore.getState();
    expect(state.pipContent).toBeNull();
    expect(state.explicitAgentPath).toBe('/agents/original');
    expect(state.requestedRightPanel).toEqual({
      tabId: 'computer',
      agentPath: '/agents/original',
      shielded: true,
    });
    expect(state.activeRightPanelTab).toBe('computer');
    expect(state.rightPanelOpen).toBe(true);
    expect(state.selectedCwd).toBe('/agents/other/workspace');
    expect(state.sessionId).toBe('other-chat');
    expectNoLifecycle(transport);
  });

  it('releases explicit control on transfer and observes in PiP without acquiring again', async () => {
    const { transport } = mount();
    await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByText('You have control');
    fireEvent.click(screen.getByRole('button', { name: 'Pop computer out' }));
    await screen.findByText('Watching');
    expect(transport.releaseComputerControl).toHaveBeenCalledWith('lease');
    expect(transport.acquireComputerControl).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('You have control')).not.toBeInTheDocument();
    expectNoLifecycle(transport);
  });

  it('returns a takeover that resolves after transfer rather than giving PiP inherited control', async () => {
    const { transport } = mount();
    let resolveLease!: (lease: { leaseId: string; generation: number }) => void;
    vi.mocked(transport.acquireComputerControl).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLease = resolve;
        })
    );
    await screen.findByAltText('Live computer desktop');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pop computer out' }));
    await act(async () => resolveLease({ leaseId: 'late', generation: 4 }));
    await waitFor(() => expect(transport.releaseComputerControl).toHaveBeenCalledWith('late'));
    expect(screen.queryByText('You have control')).not.toBeInTheDocument();
    expect(transport.sendComputerInput).not.toHaveBeenCalled();
    expectNoLifecycle(transport);
  });

  it('clears the desktop when stopped and reconnects observation without starting the guest', async () => {
    useAppStore.getState().openPip(descriptor);
    const { transport, client } = mount(false);
    await screen.findByAltText('Live computer desktop');
    const stopped = { ...ready, phase: 'stopped' as const, ready: false };
    vi.mocked(transport.getComputer).mockResolvedValue(stopped);
    act(() => client.setQueryData(COMPUTER_QUERY_KEY, stopped));
    await screen.findByText('Computer stopped.');
    expect(screen.queryByAltText('Live computer desktop')).not.toBeInTheDocument();
    const reads = vi.mocked(transport.getComputer).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(transport.getComputer).toHaveBeenCalledTimes(reads + 1));
    expect(screen.getByText('Computer stopped.')).toBeInTheDocument();
    expectNoLifecycle(transport);
  });

  it('requires reconnect after a generation change and preserves the pinned computer identity', async () => {
    useAppStore.getState().openPip(descriptor);
    const { transport, client } = mount(false);
    await screen.findByAltText('Live computer desktop');
    const restarted = { ...ready, generation: 5 };
    vi.mocked(transport.getComputer).mockResolvedValue(restarted);
    vi.mocked(transport.getComputerFrame).mockResolvedValue({ ...frame, generation: 5 });
    act(() => client.setQueryData(COMPUTER_QUERY_KEY, restarted));
    await screen.findByText('Computer restarted.');
    expect(screen.queryByAltText('Live computer desktop')).not.toBeInTheDocument();
    expect(useAppStore.getState().pipContent).toEqual(descriptor);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(useAppStore.getState().pipContent).toEqual({ ...descriptor, generation: 5 });
    await screen.findByAltText('Live computer desktop');
    expect(transport.acquireComputerControl).not.toHaveBeenCalled();
    expectNoLifecycle(transport);
  });
});
