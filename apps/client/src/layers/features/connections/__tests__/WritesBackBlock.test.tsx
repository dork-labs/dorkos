/**
 * A connected app's writes-back switch (DOR-4794): off by default, turning it
 * on waits for a confirm that says what changes and asks the person to vouch
 * the app copies nothing somewhere public, and turning it off is immediate.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport, writesBackState } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { WritesBackBlock, WRITES_BACK_LABEL } from '../ui/writes-back/WritesBackBlock';

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

function renderBlock(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return {
    transport,
    ...render(<WritesBackBlock connectionId="c-1" appName="Linear" />, { wrapper: Wrapper }),
  };
}

afterEach(cleanup);

describe('the writes-back switch', () => {
  it('is off by default, and says what still asks', async () => {
    const { transport } = renderBlock();
    const toggle = await screen.findByRole('switch', { name: WRITES_BACK_LABEL });
    expect(toggle).not.toBeChecked();
    expect(transport.getConnectorWritesBack).toHaveBeenCalledWith('c-1');
    expect(
      screen.getByText('For agents that read only Linear. Sends and deletes still ask.')
    ).toBeVisible();
  });

  // Security Must 1: a mail app's writes are sends, so it is never offered there.
  it('is hidden for an app the server does not offer it for', async () => {
    const { transport } = renderBlock({
      getConnectorWritesBack: vi
        .fn()
        .mockResolvedValue(writesBackState('c-1', { supported: false })),
    });
    await waitFor(() => expect(transport.getConnectorWritesBack).toHaveBeenCalled());
    // Let the answer land and render before checking nothing is there.
    await vi.mocked(transport.getConnectorWritesBack).mock.results[0]!.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('switch', { name: WRITES_BACK_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('turning it on needs the confirm first, and nothing changes until then', async () => {
    const { transport } = renderBlock();
    await userEvent.click(await screen.findByRole('switch', { name: WRITES_BACK_LABEL }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Let agents write back to Linear?');
    expect(dialog).toHaveTextContent(
      'Agents that only read Linear can add, edit or comment there without asking you.'
    );
    expect(dialog).toHaveTextContent('Sends, other apps and deletes still ask.');
    expect(dialog).toHaveTextContent(
      'DorkOS can’t see if Linear copies its content somewhere public, like a two-way GitHub sync.'
    );
    // Turn on waits for the person to vouch for the app.
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeDisabled();
    expect(transport.setConnectorWritesBack).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: WRITES_BACK_LABEL })).not.toBeChecked();
    expect(transport.setConnectorWritesBack).not.toHaveBeenCalled();
  });

  it('confirming turns it on with confirmsNoOutsideSync true', async () => {
    const { transport } = renderBlock();
    await userEvent.click(await screen.findByRole('switch', { name: WRITES_BACK_LABEL }));
    await userEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Linear doesn’t copy its content anywhere public',
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    expect(transport.setConnectorWritesBack).toHaveBeenCalledWith('c-1', {
      writesBackUnasked: true,
      confirmsNoOutsideSync: true,
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: WRITES_BACK_LABEL })).toBeChecked()
    );
  });

  it('turning it off calls set at once, with no confirm', async () => {
    const { transport } = renderBlock({
      getConnectorWritesBack: vi.fn().mockResolvedValue(
        writesBackState('c-1', {
          writesBackUnasked: true,
          writesBackAttestedAt: '2026-11-19T12:00:00.000Z',
        })
      ),
    });
    const toggle = await screen.findByRole('switch', { name: WRITES_BACK_LABEL });
    await waitFor(() => expect(toggle).toBeChecked());
    await userEvent.click(toggle);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(transport.setConnectorWritesBack).toHaveBeenCalledWith('c-1', {
      writesBackUnasked: false,
    });
  });

  // DOR-4909: and says nothing changed, calmly, so it never looks saved.
  it('stays off, with no error but a calm line, when "Confirm it’s you" is not confirmed', async () => {
    const { transport } = renderBlock({
      setConnectorWritesBack: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('held'), { code: STEP_UP_REQUIRED_CODE })),
    });
    await userEvent.click(await screen.findByRole('switch', { name: WRITES_BACK_LABEL }));
    await userEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Linear doesn’t copy its content anywhere public',
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    await waitFor(() => expect(transport.setConnectorWritesBack).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: WRITES_BACK_LABEL })).not.toBeChecked()
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Not confirmed. Nothing changed.');
  });
});
