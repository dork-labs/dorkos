/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { AdapterSetupWizard, unflattenConfig } from '../AdapterSetupWizard';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

// Mock motion/react to render plain elements in tests

// Toasts are the wizard's only channel for a save's outcome, so the rollback
// tests below read what it said rather than what happened to the DOM.
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseManifest: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Connect to Slack',
  category: 'messaging',
  builtin: true,
  multiInstance: false,
  configFields: [
    { key: 'token', label: 'API Token', type: 'password', required: true },
    { key: 'channel', label: 'Channel', type: 'text', required: true, default: '#general' },
    { key: 'timeout', label: 'Timeout', type: 'number', required: false },
  ],
};

const manifestWithInstructions: AdapterManifest = {
  ...baseManifest,
  setupInstructions: 'Go to slack.com/api to get your token.',
};

const _manifestWithSteps: AdapterManifest = {
  ...baseManifest,
  setupSteps: [
    { stepId: 'auth', title: 'Authentication', fields: ['token'] },
    { stepId: 'settings', title: 'Settings', fields: ['channel', 'timeout'] },
  ],
};

const telegramManifest: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Telegram bot adapter',
  category: 'messaging',
  builtin: true,
  multiInstance: true,
  configFields: [
    { key: 'token', label: 'Bot Token', type: 'password', required: true },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      required: true,
      default: 'polling',
      options: [
        { label: 'Long Polling', value: 'polling' },
        { label: 'Webhook', value: 'webhook' },
      ],
    },
  ],
};

/**
 * Telegram's real setup-step shape: a token step, then a step carrying both the
 * connection mode and the group respond mode.
 *
 * Mirrors `TELEGRAM_MANIFEST` in `@dorkos/relay`, which the client cannot import
 * (it pulls in grammy and the Slack SDKs). That every declared field reaches
 * some step is pinned against the real manifests in
 * `packages/relay/src/adapters/__tests__/wizard-field-coverage.test.ts`; this
 * fixture pins the other half — that a field a step names actually renders.
 * Fields no step names are covered in `AdapterSetupWizardUnclaimedFields.test.tsx`.
 */
const telegramSteppedManifest: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Telegram bot adapter',
  category: 'messaging',
  builtin: true,
  multiInstance: true,
  setupSteps: [
    { stepId: 'get-token', title: 'Get your Bot Token', fields: ['token'] },
    {
      stepId: 'configure-mode',
      title: 'Choose how your bot connects and replies',
      fields: ['mode', 'respondMode'],
    },
  ],
  configFields: [
    { key: 'token', label: 'Bot Token', type: 'password', required: true },
    {
      key: 'mode',
      label: 'Receiving Mode',
      type: 'select',
      required: true,
      default: 'polling',
      options: [{ label: 'Long Polling', value: 'polling' }],
    },
    {
      key: 'respondMode',
      label: 'Replies in Groups',
      type: 'select',
      displayAs: 'radio-cards',
      required: true,
      default: 'thread-aware',
      description: 'When should the bot reply in a group chat?',
      options: [
        { label: 'When spoken to', value: 'thread-aware' },
        { label: 'Only when mentioned', value: 'mention-only' },
        { label: 'Every message', value: 'always' },
      ],
    },
  ],
};

const existingInstance: CatalogInstance & { config?: Record<string, unknown> } = {
  id: 'slack-1',
  enabled: true,
  status: {
    id: 'slack-1',
    type: 'webhook',
    displayName: 'Slack',
    state: 'connected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  },
  config: { token: 'secret', channel: '#dev', timeout: 30 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(agentsData?: { agents: { id: string; name: string }[] }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const mockTransport = createMockTransport();

  // Default: one agent, so the wizard's first question answers itself and the
  // configure-step assertions below can get to the configure step.
  mockTransport.listMeshAgents = vi
    .fn()
    .mockResolvedValue(agentsData ?? { agents: [{ id: 'dorkbot', name: 'DorkBot' }] });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={mockTransport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  return { Wrapper, mockTransport, queryClient };
}

/**
 * Walk past step one.
 *
 * Adding a connection asks who answers before it asks for any setting, so every
 * assertion about a later step has to get there first. The wrapper's single
 * agent is chosen automatically; this just presses on.
 */
async function advanceToConfigure() {
  const next = await screen.findByRole('button', { name: /continue/i });
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterSetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens in add mode with empty form and no adapter ID field (auto-generated)', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    expect(screen.getByText('Add Slack')).toBeInTheDocument();
    // Adapter ID is auto-generated — no input field shown
    expect(screen.queryByLabelText(/adapter id/i)).not.toBeInTheDocument();
    // Channel should have default value, token should be empty
    expect(screen.getByLabelText(/channel/i)).toHaveValue('#general');
  });

  it('opens in edit mode with pre-filled values and no adapter ID field', () => {
    const { Wrapper } = createWrapper();
    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByText('Edit Slack')).toBeInTheDocument();
    expect(screen.queryByLabelText(/adapter id/i)).not.toBeInTheDocument();
    // Password should be pre-filled with sentinel (edit mode: shows saved indicator)
    const tokenInput = screen.getByLabelText(/api token/i);
    expect(tokenInput).toHaveValue('***');
    expect(tokenInput).toHaveAttribute('placeholder', 'Saved — enter a new one to replace');
    expect(screen.getByLabelText(/channel/i)).toHaveValue('#dev');
  });

  it('sentinel clears on focus so user can type a new value', async () => {
    const { Wrapper } = createWrapper();
    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    const tokenInput = screen.getByLabelText(/api token/i);
    expect(tokenInput).toHaveValue('***');
    fireEvent.focus(tokenInput);
    // Re-query after re-render (isSentinel → false changes the rendered branch).
    await waitFor(() => {
      expect(screen.getByLabelText(/api token/i)).toHaveValue('');
    });
  });

  it('displays setup instructions when provided', async () => {
    const { Wrapper } = createWrapper();
    render(
      <AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={manifestWithInstructions} />,
      { wrapper: Wrapper }
    );
    await advanceToConfigure();

    expect(screen.getByText('Go to slack.com/api to get your token.')).toBeInTheDocument();
  });

  it('blocks Continue when required fields are empty', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    // Token is required and empty — clicking Continue should show error
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('API Token is required')).toBeInTheDocument();
    // Should still be on configure step
    expect(screen.getByLabelText(/channel/i)).toBeInTheDocument();
  });

  it('renders the group respond-mode control on the step that names it', async () => {
    // The wizard shows only the current step's fields, so a setting is only
    // real if a step names it. This drives the actual UI rather than reasoning
    // about the manifest: fill the token, advance, and look for the control the
    // changelog tells people to go and change (DOR-619).
    const { Wrapper } = createWrapper();
    render(
      <AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={telegramSteppedManifest} />,
      { wrapper: Wrapper }
    );
    await advanceToConfigure();

    // Setup step 1 — the group setting is not here.
    expect(screen.queryByText('Replies in Groups')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: '123:ABC' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2 — the control and all three choices are on screen.
    await waitFor(() => {
      expect(screen.getByText('Replies in Groups')).toBeInTheDocument();
    });
    expect(screen.getByText('When spoken to')).toBeInTheDocument();
    expect(screen.getByText('Only when mentioned')).toBeInTheDocument();
    expect(screen.getByText('Every message')).toBeInTheDocument();
  });

  it('shows spinner during pending test, green check on success', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    // Make testRelayAdapterConnection resolve after a tick
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    // Fill required token field and continue
    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Should show test step
    await waitFor(() => {
      expect(screen.getByText('Trying to reach it...')).toBeInTheDocument();
    });

    // After resolving, should show success
    await waitFor(() => {
      expect(screen.getByText('Reachable')).toBeInTheDocument();
    });
  });

  it('shows bot identity card when botUsername is returned', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi
      .fn()
      .mockResolvedValue({ ok: true, botUsername: 'mybot' });

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText('Reachable')).toBeInTheDocument();
    });
    expect(screen.getByText('@mybot')).toBeInTheDocument();
  });

  it('shows red X on test failure', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi.fn().mockRejectedValue(new Error('Auth failed'));

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText('Not reachable')).toBeInTheDocument();
    });
    expect(screen.getByText('Auth failed')).toBeInTheDocument();
  });

  it('shows only Continue after a successful test (no duplicate Skip)', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    // On success the forward action collapses to a single "Continue" — no Skip.
    expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText('Save changes')).toBeInTheDocument();
    });
  });

  it('Skip proceeds from a failed test to the confirm step', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi
      .fn()
      .mockRejectedValue(new Error('Connection refused'));

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // On failure the forward action is "Skip" (proceed without a passing test).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^continue$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    await waitFor(() => {
      expect(screen.getByText('Save changes')).toBeInTheDocument();
    });
  });

  it('confirm step shows values with passwords masked', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'my-secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Pass the test, then continue to confirm
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // On confirm step: password should be masked with partial reveal (last 4 chars).
    // 'my-secret-token' → '•••• oken'
    await waitFor(() => {
      expect(screen.getByText('•••• oken')).toBeInTheDocument();
    });
    expect(screen.getByText('#dev')).toBeInTheDocument();
  });

  it('save calls addAdapter mutation in add mode', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.addRelayAdapter = vi.fn().mockResolvedValue({ ok: true });

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    // Fill required fields
    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'new-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Pass the test, then continue to confirm
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Save
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => {
      expect(mockTransport.addRelayAdapter).toHaveBeenCalledWith(
        'slack',
        'slack',
        expect.objectContaining({ token: 'new-token', channel: '#general' })
      );
    });
  });

  it('label input renders on configure step', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    expect(screen.getByLabelText(/name \(optional\)/i)).toBeInTheDocument();
    // Placeholder should be the manifest displayName
    expect(screen.getByLabelText(/name \(optional\)/i)).toHaveAttribute('placeholder', 'Slack');
  });

  it('label is included in addAdapter config when provided', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.addRelayAdapter = vi.fn().mockResolvedValue({ ok: true });

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    // Fill required fields and set label
    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'my-token' } });
    fireEvent.change(screen.getByLabelText(/name \(optional\)/i), {
      target: { value: 'My Slack Bot' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => {
      expect(mockTransport.addRelayAdapter).toHaveBeenCalledWith(
        'slack',
        'slack',
        expect.objectContaining({ token: 'my-token', label: 'My Slack Bot' })
      );
    });
  });

  it('label is omitted from addAdapter config when empty', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.addRelayAdapter = vi.fn().mockResolvedValue({ ok: true });

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'my-token' } });
    // Leave label empty
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => {
      expect(mockTransport.addRelayAdapter).toHaveBeenCalledWith(
        'slack',
        'slack',
        expect.not.objectContaining({ label: expect.anything() })
      );
    });
  });

  it('auto-label populates from botUsername when label is empty', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi
      .fn()
      .mockResolvedValue({ ok: true, botUsername: 'mybot' });

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    // Leave label empty and proceed to test step
    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // After test succeeds, label should be auto-populated
    await waitFor(() => {
      expect(screen.getByText('Reachable')).toBeInTheDocument();
    });

    // Navigate back to configure to verify label was set
    fireEvent.click(screen.getByRole('button', { name: /back/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/name \(optional\)/i)).toHaveValue('@mybot');
    });
  });

  it('user-set label is not overwritten by auto-label', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi
      .fn()
      .mockResolvedValue({ ok: true, botUsername: 'autobot' });

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    // Set a label before testing
    fireEvent.change(screen.getByLabelText(/name \(optional\)/i), {
      target: { value: 'My Custom Name' },
    });
    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText('Reachable')).toBeInTheDocument();
    });

    // Navigate back to confirm label wasn't overwritten
    fireEvent.click(screen.getByRole('button', { name: /back/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/name \(optional\)/i)).toHaveValue('My Custom Name');
    });
  });

  it('save calls updateConfig mutation in edit mode', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.updateRelayAdapterConfig = vi.fn().mockResolvedValue({ ok: true });

    render(
      <AdapterSetupWizard
        open={true}
        onOpenChange={vi.fn()}
        manifest={baseManifest}
        existingInstance={existingInstance}
      />,
      { wrapper: Wrapper }
    );

    const tokenInput = screen.getByLabelText(/api token/i);
    fireEvent.change(tokenInput, { target: { value: 'updated-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Pass the test, then continue to confirm
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Save
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockTransport.updateRelayAdapterConfig).toHaveBeenCalledWith(
        'slack-1',
        expect.objectContaining({ token: 'updated-token', channel: '#dev' })
      );
    });
  });

  it('says so, and blocks, when there is no agent to answer', async () => {
    const { Wrapper } = createWrapper({ agents: [] });

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });

    // Step one is the agent question, and with no agents it has no answer —
    // so the wizard refuses to go on rather than creating a connection that
    // reaches nobody.
    await waitFor(() => {
      expect(screen.getByText(/you have no agents yet/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    expect(screen.queryByLabelText(/api token/i)).not.toBeInTheDocument();
  });

  it('chooses the only agent for you and names it on the way through', async () => {
    const { Wrapper, mockTransport } = createWrapper({
      agents: [{ id: 'agent-1', name: 'My Agent' }],
    });
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.addRelayAdapter = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.createBinding = vi.fn().mockResolvedValue({ id: 'b-1' });

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(screen.getByText('My Agent')).toBeInTheDocument();
    });
    await advanceToConfigure();

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'my-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // The confirm step repeats the promise before it is kept.
    await waitFor(() => {
      expect(screen.getByText(/messages that arrive here go to/i)).toBeInTheDocument();
    });
    expect(screen.getByText('My Agent')).toBeInTheDocument();
  });

  it('saves the connection and the agent that answers it together', async () => {
    const { Wrapper, mockTransport } = createWrapper({
      agents: [{ id: 'agent-1', name: 'My Agent' }],
    });
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.addRelayAdapter = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.createBinding = vi.fn().mockResolvedValue({ id: 'b-1' });

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'my-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    // Both calls, not one: a connection nobody answers is never what a save
    // leaves behind.
    await waitFor(() => {
      expect(mockTransport.addRelayAdapter).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockTransport.createBinding).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'slack', agentId: 'agent-1' })
      );
    });
  });

  it('takes the connection back out when the agent could not be set', async () => {
    const { Wrapper, mockTransport } = createWrapper({
      agents: [{ id: 'agent-1', name: 'My Agent' }],
    });
    mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.addRelayAdapter = vi.fn().mockResolvedValue({ ok: true });
    mockTransport.createBinding = vi.fn().mockRejectedValue(new Error('nope'));
    mockTransport.removeRelayAdapter = vi.fn().mockResolvedValue(undefined);

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'my-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => {
      expect(mockTransport.removeRelayAdapter).toHaveBeenCalledWith('slack');
    });
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Nothing was set up', expect.anything());
    });
  });

  it('tells the truth when the undo itself fails, leaving an agent-less connection', async () => {
    // The double failure the atomicity promise cannot keep on its own: the
    // binding POST fails AND the rollback DELETE fails too. The adapter is now
    // live on the server with no agent to answer it — the exact silent-shadow
    // state this feature exists to prevent — so the toast must stop claiming
    // "nothing was set up" and say what is actually still there.
    const rejection = vi.fn();
    const onUnhandled = (e: PromiseRejectionEvent) => {
      e.preventDefault();
      rejection(e.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    try {
      const { Wrapper, mockTransport } = createWrapper({
        agents: [{ id: 'agent-1', name: 'My Agent' }],
      });
      mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
      mockTransport.addRelayAdapter = vi.fn().mockResolvedValue({ ok: true });
      mockTransport.createBinding = vi.fn().mockRejectedValue(new Error('binding refused'));
      mockTransport.removeRelayAdapter = vi.fn().mockRejectedValue(new Error('delete refused'));

      render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={baseManifest} />, {
        wrapper: Wrapper,
      });
      await advanceToConfigure();

      fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: 'my-token' } });
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => {
        expect(screen.getByText(/reachable/i)).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

      await waitFor(() => {
        expect(mockTransport.removeRelayAdapter).toHaveBeenCalledWith('slack');
      });
      // The honest toast: not "nothing was set up", but "remove it by hand".
      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith(
          "Couldn't finish undoing",
          expect.objectContaining({
            description: expect.stringMatching(/has no agent to answer it.*by hand/i),
          })
        );
      });
      expect(toastError).not.toHaveBeenCalledWith('Nothing was set up', expect.anything());

      // The failing rollback must not surface as an unhandled promise rejection.
      await new Promise((r) => setTimeout(r, 0));
      expect(rejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  });

  it('offers the bot link on the confirm step, once the check reports a handle', async () => {
    const { Wrapper, mockTransport } = createWrapper({
      agents: [{ id: 'agent-1', name: 'My Agent' }],
    });
    mockTransport.testRelayAdapterConnection = vi
      .fn()
      .mockResolvedValue({ ok: true, botUsername: 'mybot' });

    render(<AdapterSetupWizard open={true} onOpenChange={vi.fn()} manifest={telegramManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: 'my-token' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /message @mybot/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', 'https://t.me/mybot');
    });
  });
});
