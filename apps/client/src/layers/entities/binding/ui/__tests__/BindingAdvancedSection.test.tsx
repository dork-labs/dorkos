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
      // The binding sits at the Ask stop, which is where a `plan` that lost its
      // `axis: 'working'` would surface — NOT as a fourth radio (it merges into
      // the stop `default` already holds) but as a refinement SWITCH inside it.
      // Asserting only on radios passes through that regression.
      renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      expect(screen.getByRole('radio', { name: 'Ask first' })).toBeChecked();
      expect(screen.queryByRole('radio', { name: /plan/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: /plan/i })).not.toBeInTheDocument();
    });

    it('applies the mode the runtime declared for the stop', async () => {
      const { onPermissionModeChange } = renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Act' }));
      expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
    });
  });

  describe('before the runtime has said anything', () => {
    // One round trip on every cold open, and forever under a test-mode boot,
    // where `claude-code` is never registered at all. The old screen rendered a
    // Select with four items regardless; this one must not render a heading, an
    // empty caption and a note about a control that is not there.
    it('names the stored mode and says why there is nothing to pick', async () => {
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockResolvedValue({
          defaultRuntime: 'test-mode',
          capabilities: {},
        }),
      });
      renderSection({ permissionMode: 'bypassPermissions' }, transport);

      const note = await screen.findByTestId('trust-dial-unavailable');
      expect(note).toHaveTextContent(/Bypass All/);
      expect(note).toHaveTextContent(/hasn’t said what it can do/);
      expect(note).toHaveTextContent(/saving keeps it as it is/i);
      expect(screen.queryByRole('radiogroup', { name: /how much/i })).not.toBeInTheDocument();
      // The scope note is about a bypass mode a person just CHOSE. With no dial
      // to choose on, it is a clarification about nothing.
      expect(screen.queryByText(/This covers tools inside the session/)).not.toBeInTheDocument();
    });
  });

  describe('a binding saved at a mode the dial has no stop for', () => {
    it('keeps it, and says saving keeps it, rather than quietly widening it', async () => {
      const { onPermissionModeChange } = renderSection({ permissionMode: 'plan' });

      const note = await screen.findByTestId('trust-dial-stranded');
      // The runtime's own word for the mode, not the client's id table — the
      // descriptor is right here, and a table is only ever the fallback.
      expect(note).toHaveTextContent(/“Plan”/);
      expect(note).toHaveTextContent(/saving keeps it as it is/i);
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
      expect(alert).toHaveTextContent(/refused after 10 minutes/);
      // Not every adapter can draw a button. The sentence must be true for a
      // webhook binding, which gets no buttons and auto-denies every ask.
      expect(alert).toHaveTextContent(/where your integration can show buttons/i);
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

  describe('session strategy when bridged (chats-as-channels §7.2)', () => {
    it('shows the session-strategy selector for an unbridged binding', () => {
      renderSection({ bridged: false });
      expect(screen.getByLabelText('Session strategy')).toBeInTheDocument();
      expect(screen.queryByText(/keeps its history in the channel/i)).not.toBeInTheDocument();
    });

    it('hides the selector for a bridged binding and explains why', () => {
      renderSection({ bridged: true });
      // The <select> is gone; a plain line takes its place.
      expect(screen.queryByRole('combobox', { name: /session strategy/i })).not.toBeInTheDocument();
      expect(screen.getByText(/keeps its history in the channel/i)).toBeInTheDocument();
    });
  });

  describe('a middle stop that never asks (DOR-816)', () => {
    /** A binding whose runtime declares Codex's shape: the Act stop cannot ask. */
    function renderCodexBinding(overrides: { permissionMode?: PermissionMode } = {}) {
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
      return renderSection(overrides, transport);
    }

    it('asks first, in the words of the stop the person picked', async () => {
      // An integration nobody is watching is where a stop that never asks
      // matters most: there is no one to notice it did not ask.
      const { onPermissionModeChange } = renderCodexBinding();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Act' }));

      expect(onPermissionModeChange).not.toHaveBeenCalled();
      const alert = await screen.findByRole('alertdialog');
      // The dial's word for what they pressed, never "Full autonomy" — this
      // mode is bounded to the workspace and saying otherwise would be false.
      expect(alert).toHaveTextContent('Turn on Act');
      expect(alert).not.toHaveTextContent(/Full autonomy/);
      // The fact the stop's own name hides, and the runtime's own sentence.
      // Announced rather than merely present: a sentence outside the element
      // `aria-describedby` points at is one a screen reader never reads.
      const note = within(alert).getByTestId('consent-asks-note');
      expect(note).toHaveTextContent(/never pauses to ask/i);
      const describedBy = alert.getAttribute('aria-describedby');
      expect(describedBy, 'the dialog must point at a description').toBeTruthy();
      const description = document.getElementById(describedBy!);
      expect(description).toContainElement(note);
      // And not run into the sentence before it when read out: the accessible
      // description comes from text content, which ignores the line break.
      expect(description?.textContent).toMatch(/pause to ask\.\sThis stop never pauses/);
      expect(alert).toHaveTextContent(/can't pause to ask/);
      // The correction the strongest sentence has to arrive with (DOR-816).
      expect(alert).toHaveTextContent(/Actions on DorkOS itself/);
    });

    it('applies it only once the person confirms', async () => {
      const { onPermissionModeChange } = renderCodexBinding();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Act' }));
      await userEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn on Act' })
      );

      expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
    });

    it('leaves a stop that still asks alone', async () => {
      // The same Act stop on a runtime that CAN pause: no dialog, one click.
      const { onPermissionModeChange } = renderSection();

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Act' }));

      expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('leaves a read-only stop alone, though it never asks either', async () => {
      // Codex's read-only default never asks because it has nothing to ask
      // about. A door in front of the safest setting is how a door stops being
      // read — so picking Ask first applies at once.
      const { onPermissionModeChange } = renderCodexBinding({ permissionMode: 'acceptEdits' });

      await waitFor(() => expect(dial()).toBeInTheDocument());
      await userEvent.click(screen.getByRole('radio', { name: 'Ask first' }));
      expect(onPermissionModeChange).toHaveBeenCalledWith('default');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });
});
