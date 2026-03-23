/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ComposeMessageDialog } from '../ComposeMessageDialog';

// Mock sonner
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const transport = createMockTransport({
    sendRelayMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
  });
  return {
    transport,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

/**
 * Radix Dialog renders content twice in jsdom — once in the portal (role=dialog)
 * and once hidden. Scope all queries to `within(getByRole('dialog'))` to avoid
 * "multiple elements found" errors.
 */
function d() {
  return within(screen.getByRole('dialog'));
}

/**
 * Fill a field and fire blur so TanStack Form marks it touched.
 * Required for Zod `onSubmit` validators to surface errors.
 */
function fill(el: Element, value: string) {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}

describe('ComposeMessageDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('trigger button (uncontrolled)', () => {
    it('renders Compose trigger button', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog />, { wrapper });
      expect(screen.getByTestId('compose-trigger')).toBeInTheDocument();
    });
  });

  describe('dialog content (controlled open)', () => {
    it('renders all three fields and the title when open', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      expect(d().getByText('Send Test Message')).toBeInTheDocument();
      expect(d().getByPlaceholderText('e.g. relay.test.ping')).toBeInTheDocument();
      expect(d().getByDisplayValue('relay.human.console')).toBeInTheDocument();
      expect(d().getByPlaceholderText(/plain text or json/i)).toBeInTheDocument();
    });

    it('has default from value of relay.human.console', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      expect(d().getByDisplayValue('relay.human.console')).toHaveValue('relay.human.console');
    });

    it('subject field accepts input', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const subjectInput = d().getByPlaceholderText('e.g. relay.test.ping');
      fireEvent.change(subjectInput, { target: { value: 'relay.test.ping' } });
      expect(subjectInput).toHaveValue('relay.test.ping');
    });

    it('does not submit when required fields are empty', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });

      // Leave subject and payload empty, just click send
      await act(async () => {
        fireEvent.click(d().getByRole('button', { name: /send/i }));
      });

      // Wait a tick to ensure any async submission would have fired
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.sendRelayMessage).not.toHaveBeenCalled();
    });

    it('calls sendRelayMessage on valid submit', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });

      fill(d().getByPlaceholderText('e.g. relay.test.ping'), 'test.subject');
      fill(d().getByPlaceholderText(/plain text or json/i), 'hello');

      await act(async () => {
        fireEvent.click(d().getByRole('button', { name: /send/i }));
      });

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalled();
      });
    });

    it('wraps plain-text payload as { content }', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });

      fill(d().getByPlaceholderText('e.g. relay.test.ping'), 'relay.test.ping');
      fill(d().getByPlaceholderText(/plain text or json/i), 'plain text');

      await act(async () => {
        fireEvent.click(d().getByRole('button', { name: /send/i }));
      });

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalledWith(
          expect.objectContaining({ payload: { content: 'plain text' } })
        );
      });
    });

    it('passes parsed JSON payload directly', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });

      fill(d().getByPlaceholderText('e.g. relay.test.ping'), 'relay.test.ping');
      fill(d().getByPlaceholderText(/plain text or json/i), '{"key":"value"}');

      await act(async () => {
        fireEvent.click(d().getByRole('button', { name: /send/i }));
      });

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalledWith(
          expect.objectContaining({ payload: { key: 'value' } })
        );
      });
    });

    it('includes updated from field value in mutation call', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });

      fill(d().getByPlaceholderText('e.g. relay.test.ping'), 'relay.test.ping');
      fill(d().getByDisplayValue('relay.human.console'), 'relay.agent.mybot');
      fill(d().getByPlaceholderText(/plain text or json/i), 'hello');

      await act(async () => {
        fireEvent.click(d().getByRole('button', { name: /send/i }));
      });

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalledWith(
          expect.objectContaining({ from: 'relay.agent.mybot', subject: 'relay.test.ping' })
        );
      });
    });
  });
});
