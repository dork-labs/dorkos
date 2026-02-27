/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

/** Radix renders dialog content twice in jsdom. Scope queries to the visible role=dialog element. */
function getDialog() {
  return screen.getByRole('dialog');
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
    it('renders form fields and title when open', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const dialog = getDialog();
      expect(within(dialog).getByText('Send Test Message')).toBeInTheDocument();
      // Inputs are present via placeholder text
      expect(within(dialog).getByPlaceholderText('e.g. relay.test.ping')).toBeInTheDocument();
      expect(within(dialog).getByDisplayValue('relay.human.console')).toBeInTheDocument();
    });

    it('has default from value of relay.human.console', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      expect(within(getDialog()).getByDisplayValue('relay.human.console')).toBeInTheDocument();
    });

    it('subject input is present and required', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const subjectInput = within(getDialog()).getByPlaceholderText('e.g. relay.test.ping');
      expect(subjectInput).toBeRequired();
    });

    it('from input is present and required', () => {
      const { wrapper } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const fromInput = within(getDialog()).getByDisplayValue('relay.human.console');
      expect(fromInput).toBeRequired();
    });

    it('sends message on submit', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const dialog = getDialog();
      fireEvent.change(within(dialog).getByPlaceholderText('e.g. relay.test.ping'), {
        target: { value: 'test.subject' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalled();
      });
    });

    it('wraps plain-text payload as { content }', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const dialog = getDialog();
      fireEvent.change(within(dialog).getByPlaceholderText('e.g. relay.test.ping'), {
        target: { value: 'relay.test.ping' },
      });
      fireEvent.change(
        within(dialog).getByPlaceholderText(/plain text or json/i),
        { target: { value: 'plain text' } },
      );
      fireEvent.click(within(dialog).getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalledWith(
          expect.objectContaining({ payload: { content: 'plain text' } }),
        );
      });
    });

    it('passes parsed JSON payload directly', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const dialog = getDialog();
      fireEvent.change(within(dialog).getByPlaceholderText('e.g. relay.test.ping'), {
        target: { value: 'relay.test.ping' },
      });
      fireEvent.change(
        within(dialog).getByPlaceholderText(/plain text or json/i),
        { target: { value: '{"key":"value"}' } },
      );
      fireEvent.click(within(dialog).getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalledWith(
          expect.objectContaining({ payload: { key: 'value' } }),
        );
      });
    });

    it('includes from field value in mutation call', async () => {
      const { wrapper, transport } = createWrapper();
      render(<ComposeMessageDialog open={true} onOpenChange={vi.fn()} />, { wrapper });
      const dialog = getDialog();
      fireEvent.change(within(dialog).getByPlaceholderText('e.g. relay.test.ping'), {
        target: { value: 'relay.test.ping' },
      });
      fireEvent.change(within(dialog).getByDisplayValue('relay.human.console'), {
        target: { value: 'relay.agent.mybot' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(transport.sendRelayMessage).toHaveBeenCalledWith(
          expect.objectContaining({ from: 'relay.agent.mybot', subject: 'relay.test.ping' }),
        );
      });
    });
  });
});
