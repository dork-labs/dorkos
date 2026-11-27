// @vitest-environment jsdom
/**
 * The chat header's pull requests (W5, DOR-4971): nothing while there are
 * none, a count once there are, and the list behind a press.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { WorkPage } from '@dorkos/shared/work-graph-reads';
import { TransportProvider } from '@/layers/shared/model';
import { workGraphKeys } from '@/layers/entities/work-graph';
import { ChatWorkChip } from '../ui/ChatWorkChip';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

function renderChip(page: WorkPage) {
  const transport = createMockTransport();
  transport.getChatWork = vi.fn().mockResolvedValue(page);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ChatWorkChip sessionId="chat-1" />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, client };
}

describe('ChatWorkChip', () => {
  it('draws nothing while the chat and its spin-offs have no pull requests', async () => {
    const { client } = renderChip({ items: [], nextCursor: null });
    // Settled first: before the answer the chip draws nothing either, so an
    // absence read then could not tell "none" from "not yet".
    await vi.waitFor(() =>
      expect(client.getQueryState(workGraphKeys.chatWork('chat-1', 'pr'))?.status).toBe('success')
    );
    expect(screen.queryByTestId('chat-work-chip')).not.toBeInTheDocument();
  });

  it('counts them, and lists them when pressed', async () => {
    const { transport } = renderChip({
      items: [
        {
          ref: { kind: 'pr', id: 'dork-labs/dorkos#42' },
          text: 'dork-labs/dorkos#42',
          firstRecordedOn: '2026-11-24',
          links: [{ relation: 'opened', chatId: 'child', recordedAt: '2026-11-24T10:00:00.000Z' }],
        },
      ],
      nextCursor: 'more',
    });
    expect(transport.getChatWork).toHaveBeenCalledWith('chat-1', { kind: 'pr' });
    const chip = await screen.findByTestId('chat-work-chip');
    // A next page waits, so the count is a floor.
    expect(chip).toHaveTextContent('1+ PRs');
    await userEvent.click(chip);
    expect(await screen.findByText('dork-labs/dorkos#42')).toBeInTheDocument();
    expect(screen.getByText(/In a spin-off/)).toBeInTheDocument();
  });
});
