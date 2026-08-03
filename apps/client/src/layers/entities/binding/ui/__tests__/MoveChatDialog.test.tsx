/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MoveChatDialog, readChatConflict } from '../MoveChatDialog';

afterEach(cleanup);

const NEXT = { id: 'auditor', name: 'security-auditor' };

function wrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('readChatConflict', () => {
  it('reads the binding that already owns the chat', () => {
    const err = Object.assign(new Error('already bound'), {
      code: 'CHAT_ALREADY_BOUND',
      status: 409,
      body: {
        error: 'already bound',
        code: 'CHAT_ALREADY_BOUND',
        conflict: { bindingId: 'b-1', agentId: 'dorkbot', label: '' },
      },
    });

    expect(readChatConflict(err, NEXT)).toEqual({
      bindingId: 'b-1',
      currentAgentName: 'dorkbot',
      nextAgentId: 'auditor',
      nextAgentName: 'security-auditor',
    });
  });

  it('ignores any other failure', () => {
    expect(readChatConflict(new Error('network down'), NEXT)).toBeNull();
    expect(readChatConflict(null, NEXT)).toBeNull();
  });

  it('refuses a conflict it cannot act on', () => {
    // The code alone is not enough: without the binding id there is nothing to
    // move, and offering a move that cannot be performed is worse than the
    // plain error.
    const err = Object.assign(new Error('already bound'), {
      code: 'CHAT_ALREADY_BOUND',
      body: { code: 'CHAT_ALREADY_BOUND' },
    });

    expect(readChatConflict(err, NEXT)).toBeNull();
  });
});

describe('MoveChatDialog', () => {
  it('asks for nothing while there is no conflict', () => {
    // Mounted on every surface that creates a binding, so an idle dialog must
    // not reach for a transport — it renders nothing at all.
    expect(() => render(<MoveChatDialog conflict={null} onClose={vi.fn()} />)).not.toThrow();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names who has the chat and who would get it', () => {
    const transport = createMockTransport({ moveBinding: vi.fn() });
    render(
      <MoveChatDialog
        conflict={{
          bindingId: 'b-1',
          currentAgentName: 'DorkBot',
          nextAgentId: 'auditor',
          nextAgentName: 'security-auditor',
        }}
        onClose={vi.fn()}
      />,
      { wrapper: wrapper(transport) }
    );

    expect(screen.getByText(/this chat reaches/i)).toBeInTheDocument();
    expect(screen.getByText('DorkBot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move it to security-auditor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave it' })).toBeInTheDocument();
  });
});
