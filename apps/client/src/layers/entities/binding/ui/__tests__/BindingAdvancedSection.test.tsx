/**
 * How much an agent behind an integration may do, and how that choice is made.
 *
 * The binding dialog used to answer this from a four-item list written by hand:
 * copy that described Claude Code and nothing else ("asks before running shell
 * commands" is false on Codex), and a `plan` option that is not a level of trust
 * at all. It now renders the same Trust Dial as every other picker, built from
 * what the runtime declared.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { BindingAdvancedSection } from '../BindingAdvancedSection';

afterEach(cleanup);

/**
 * Codex's declared modes — the runtime the honesty problem was found on. Its
 * middle stop runs shell commands and cannot pause to ask, which the retired
 * hand-written copy claimed the opposite of.
 */
const CODEX_MODES = [
  {
    id: 'default',
    label: 'Read only',
    stop: 'ask' as const,
    asks: 'never' as const,
    reach: 'read' as const,
    promise: 'Reads files and answers questions. Nothing on your machine changes.',
  },
  {
    id: 'acceptEdits',
    label: 'Workspace write',
    stop: 'act' as const,
    asks: 'never' as const,
    reach: 'workspace' as const,
    promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
  },
];

function wrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function renderSection(
  overrides: Partial<Parameters<typeof BindingAdvancedSection>[0]> = {},
  transport: Transport = createMockTransport()
) {
  const onPermissionModeChange = vi.fn();
  const props = {
    strategy: 'per-chat' as const,
    onStrategyChange: vi.fn(),
    permissionMode: 'default' as PermissionMode,
    onPermissionModeChange,
    canInitiate: true,
    onCanInitiateChange: vi.fn(),
    canReply: true,
    onCanReplyChange: vi.fn(),
    canReceive: true,
    onCanReceiveChange: vi.fn(),
    notifyOnTaskComplete: false,
    onNotifyOnTaskCompleteChange: vi.fn(),
    open: true,
    onOpenChange: vi.fn(),
    hasChanges: false,
    ...overrides,
  };
  render(<BindingAdvancedSection {...props} />, { wrapper: wrapper(transport) });
  return { onPermissionModeChange: props.onPermissionModeChange };
}

/** The dial's radio group. */
function dial() {
  return screen.getByRole('radiogroup', { name: /how much/i });
}

describe('BindingAdvancedSection permissions', () => {
  describe('the dial', () => {
    it('offers the three stops instead of a hand-written mode list', async () => {
      renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      expect(
        within(dial())
          .getAllByRole('radio')
          .map((s) => s.textContent)
      ).toEqual(['Ask first', 'Act', 'Full autonomy']);
    });

    it('says what the runtime does, not what a list in the client claimed', async () => {
      renderSection({ permissionMode: 'acceptEdits' });

      // The retired copy said "asks before running shell commands" for every
      // runtime. This is the runtime's own sentence.
      expect(
        await screen.findByText('Edits files on its own. Asks before it runs a command.')
      ).toBeInTheDocument();
      expect(screen.queryByText(/asks before running shell commands/i)).not.toBeInTheDocument();
    });

    it('warns in amber on a runtime that cannot keep the stop’s promise', async () => {
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockResolvedValue({
          defaultRuntime: 'claude-code',
          capabilities: {
            'claude-code': {
              type: 'claude-code',
              supportsToolApproval: true,
              supportsCostTracking: false,
              supportsResume: true,
              supportsMcp: true,
              supportsQuestionPrompt: true,
              supportsPlugins: true,
              permissionModes: { supported: true, values: CODEX_MODES },
              features: {},
            },
          },
        }),
      });
      renderSection({ permissionMode: 'acceptEdits' }, transport);

      await waitFor(() =>
        expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(/can't pause to ask/)
      );
      expect(screen.getByTestId('trust-dial-caption').className).toContain('amber');
    });

    it('never offers planning as a level of trust', async () => {
      renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      expect(screen.queryByRole('radio', { name: /plan/i })).not.toBeInTheDocument();
    });

    it('applies the mode the runtime declared for the stop', async () => {
      const { onPermissionModeChange } = renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Act' }));
      expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
    });
  });

  describe('a binding saved at a mode the dial has no stop for', () => {
    it('keeps it, and says saving keeps it, rather than quietly widening it', async () => {
      const { onPermissionModeChange } = renderSection({ permissionMode: 'plan' });

      const note = await screen.findByTestId('trust-dial-stranded');
      expect(note).toHaveTextContent(/Plan/);
      expect(note).toHaveTextContent(/Saving keeps it as it is/);
      expect(within(dial()).queryAllByRole('radio', { checked: true })).toHaveLength(0);
      expect(onPermissionModeChange).not.toHaveBeenCalled();
    });
  });

  describe('the autonomy stop', () => {
    it('asks before it is applied, and names what stops happening in the chat', async () => {
      const { onPermissionModeChange } = renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));

      expect(onPermissionModeChange).not.toHaveBeenCalled();
      const alert = await screen.findByRole('alertdialog');
      expect(alert).toHaveTextContent(/Turn on Full autonomy/);
      // The facts that are true HERE and nowhere else: who could have answered,
      // and what happens to an ask nobody answers.
      expect(alert).toHaveTextContent(/approver/i);
      expect(alert).toHaveTextContent(/10 minutes/);
    });

    it('applies it only once the person confirms', async () => {
      const { onPermissionModeChange } = renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));
      await userEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', {
          name: 'Turn on Full autonomy',
        })
      );

      expect(onPermissionModeChange).toHaveBeenCalledWith('bypassPermissions');
    });

    it('leaves the mode alone when the person backs out', async () => {
      const { onPermissionModeChange } = renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));
      await userEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' })
      );

      expect(onPermissionModeChange).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });
  });
});
