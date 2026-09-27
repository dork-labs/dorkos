/**
 * @vitest-environment jsdom
 */
/**
 * The preset picker (spec `agent-permissions` D5, tasks 3.7 and 3.8): what it
 * reads, the Full autonomy consent step, the "agents set differently" question,
 * and the one sentence that travels with Full power (DOR-2102).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type { PermissionsResponse } from '@dorkos/shared/permissions';
import type { ServerConfig } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { PresetPicker } from '../ui/PresetPicker';
import { NewAgentRecordNotice } from '../ui/NewAgentRecordNotice';

afterEach(() => cleanup());

const OVERVIEW: PermissionsResponse = {
  preset: 'balanced',
  defaults: { areas: {}, actions: {} },
  changeCount: 0,
  filesAndCommands: { stop: 'act', presetStop: 'act', runtimes: [], exceptions: [] },
  areas: [],
  exceptions: [],
  agentCount: 4,
};

function renderPicker(overview: PermissionsResponse, acknowledgedAt: string | null = null) {
  const transport = createMockTransport({
    getPermissions: vi.fn().mockResolvedValue(overview),
    getConfig: vi.fn().mockResolvedValue({
      ui: { autonomyAcknowledgedAt: acknowledgedAt },
    } as unknown as ServerConfig),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<PresetPicker surface="control-center" />, { wrapper });
  return transport;
}

/** The scope note, found by its slot. */
const scopeNote = () => document.querySelector('[data-slot="permission-mode-scope-note"]');

describe('PresetPicker', () => {
  it('reads "Not chosen yet" before anyone has chosen', async () => {
    renderPicker({ ...OVERVIEW, preset: null });
    expect(
      await screen.findByText('Not chosen yet. Your agents work as they did before.')
    ).toBeInTheDocument();
  });

  it('counts the changes on top of the preset, and resets them', async () => {
    const transport = renderPicker({ ...OVERVIEW, changeCount: 2 });
    expect(await screen.findByText('Balanced, 2 changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset to Balanced' }));
    await waitFor(() =>
      expect(transport.setPermissionPreset).toHaveBeenCalledWith({
        preset: 'balanced',
        surface: 'control-center',
      })
    );
  });

  it('chooses a preset that asks nothing more straight away', async () => {
    const transport = renderPicker(OVERVIEW);
    await userEvent.click(await screen.findByRole('radio', { name: 'Careful' }));
    await waitFor(() =>
      expect(transport.setPermissionPreset).toHaveBeenCalledWith({
        preset: 'careful',
        surface: 'control-center',
      })
    );
  });

  it('asks before Full power, and sends the yes with the preset', async () => {
    const transport = renderPicker(OVERVIEW);
    await userEvent.click(await screen.findByRole('radio', { name: 'Full power' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(transport.setPermissionPreset).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: /Turn on|Full autonomy/ }));
    await waitFor(() =>
      expect(transport.setPermissionPreset).toHaveBeenCalledWith({
        preset: 'full',
        surface: 'control-center',
        acknowledgeAutonomy: true,
      })
    );
  });

  it('does not ask again once the acknowledgement is on file', async () => {
    const transport = renderPicker(OVERVIEW, '2026-08-01T00:00:00.000Z');
    // The acknowledgement is read from config; wait for it to land.
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole('radio', { name: 'Full power' }));
    await waitFor(() =>
      expect(transport.setPermissionPreset).toHaveBeenCalledWith({
        preset: 'full',
        surface: 'control-center',
      })
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks which agents set differently should follow, with nothing checked', async () => {
    const transport = renderPicker({
      ...OVERVIEW,
      exceptions: [{ agentId: 'a1', agentName: 'auditor', area: 'rooms', state: 'blocked' }],
      filesAndCommands: {
        ...OVERVIEW.filesAndCommands,
        exceptions: [{ agentId: 'a1', agentName: 'auditor', stop: 'ask' }],
      },
    });
    await userEvent.click(await screen.findByRole('radio', { name: 'Careful' }));
    expect(await screen.findByText('Switch everyone to Careful?')).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'auditor: 2 settings of its own' });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Update selected' }));
    await waitFor(() =>
      expect(transport.setPermissionPreset).toHaveBeenCalledWith({
        preset: 'careful',
        surface: 'control-center',
        applyToAgents: ['a1'],
      })
    );
  });

  it('carries the note on what Full autonomy does not cover at Full power', async () => {
    renderPicker({
      ...OVERVIEW,
      preset: 'full',
      filesAndCommands: { stop: 'autonomy', presetStop: 'autonomy', runtimes: [], exceptions: [] },
    });
    await waitFor(() => expect(scopeNote()).toBeInTheDocument());
    expect(scopeNote()).toHaveTextContent(/DorkOS’s own risky actions still stop for you/);
  });

  it('says nothing more at a stop that still asks', async () => {
    renderPicker(OVERVIEW);
    await screen.findByTestId('permissions-preset');
    expect(scopeNote()).not.toBeInTheDocument();
  });

  it('draws the three choices while loading, and chooses nothing until the answer arrives', async () => {
    const transport = createMockTransport({
      getPermissions: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <PresetPicker surface="control-center" />
        </TransportProvider>
      </QueryClientProvider>
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Careful' }));
    expect(transport.setPermissionPreset).not.toHaveBeenCalled();
    expect(screen.getByTestId('preset-picker')).toHaveAttribute('aria-busy', 'true');
  });

  it('says so when the permissions cannot be read', async () => {
    const transport = createMockTransport({
      getPermissions: vi.fn().mockRejectedValue(new Error('not here')),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <PresetPicker surface="settings" />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('Couldn’t read the permissions.')).toBeInTheDocument();
  });
});

describe('NewAgentRecordNotice', () => {
  function renderNotice(overview: PermissionsResponse) {
    const transport = createMockTransport({
      getPermissions: vi.fn().mockResolvedValue(overview),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <NewAgentRecordNotice />
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  it('says so when DorkOS cannot read its record of new agents', async () => {
    renderNotice({ ...OVERVIEW, newAgentRecordUnreadable: true });
    expect(await screen.findByTestId('permissions-record-unreadable')).toHaveTextContent(
      /couldn’t read its record/
    );
  });

  it('says nothing while the record is fine', async () => {
    renderNotice(OVERVIEW);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('permissions-record-unreadable')).not.toBeInTheDocument();
  });
});
