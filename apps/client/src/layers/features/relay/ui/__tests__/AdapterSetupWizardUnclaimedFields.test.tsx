/**
 * @vitest-environment jsdom
 *
 * A setting an adapter declares must be reachable in the wizard even when no
 * setup step names it. Before DOR-640 the wizard rendered only the current
 * step's fields and dropped the rest, which hid Slack's DM policy and both
 * adapters' approver lists — settings that decide who may talk to an agent and
 * who may approve what it runs.
 *
 * The fixtures below mirror the real Slack and Telegram manifests' step/field
 * split. The client cannot import `@dorkos/relay` (it pulls in grammy and the
 * Slack SDKs), so the same sweep runs against the live manifests in a real
 * browser in `apps/e2e/tests/relay/adapter-wizard-fields.spec.ts`, and the
 * manifest half of the invariant is pinned in
 * `packages/relay/src/adapters/__tests__/wizard-field-coverage.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { AdapterSetupWizard } from '../AdapterSetupWizard';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Fixtures — the real step/field splits, trimmed to what this file asserts
// ---------------------------------------------------------------------------

/** Slack: one setup step, five access-control fields it never names. */
const slackShapedManifest: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Send and receive messages in Slack channels and DMs.',
  category: 'messaging',
  builtin: true,
  multiInstance: true,
  setupSteps: [
    {
      stepId: 'create-app',
      title: 'Create & Configure a Slack App',
      fields: ['botToken', 'streaming'],
    },
  ],
  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true },
    { key: 'streaming', label: 'Stream Responses', type: 'boolean', required: false },
    {
      key: 'dmPolicy',
      label: 'DM Access',
      type: 'select',
      required: true,
      default: 'allowlist',
      section: 'Access Control',
      displayAs: 'radio-cards',
      options: [
        { label: 'Open (anyone)', value: 'open' },
        { label: 'Allowlist only', value: 'allowlist' },
      ],
    },
    {
      key: 'dmAllowlist',
      label: 'DM Allowlist',
      type: 'textarea',
      required: false,
      section: 'Access Control',
      showWhen: { field: 'dmPolicy', equals: 'allowlist' },
    },
    {
      key: 'approverAllowlist',
      label: 'Approvers',
      type: 'textarea',
      required: false,
      section: 'Access Control',
    },
    {
      key: 'channelOverrides',
      label: 'Channel Overrides',
      type: 'textarea',
      required: false,
      section: 'Access Control',
    },
  ],
};

/** Telegram: two setup steps, two fields with no step and no section of their own. */
const telegramShapedManifest: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via a Telegram bot.',
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
    { key: 'streaming', label: 'Streaming', type: 'boolean', required: false },
    {
      key: 'respondMode',
      label: 'Replies in Groups',
      type: 'select',
      required: true,
      default: 'thread-aware',
      options: [{ label: 'When spoken to', value: 'thread-aware' }],
    },
    { key: 'approverAllowlist', label: 'Approvers', type: 'textarea', required: false },
  ],
};

/** No setup steps at all — every field already rendered before the fix. */
const steplessManifest: AdapterManifest = {
  type: 'webhook',
  displayName: 'Webhook',
  description: 'Inbound and outbound webhooks.',
  category: 'automation',
  builtin: true,
  multiInstance: true,
  configFields: [
    { key: 'inbound.subject', label: 'Inbound Subject', type: 'text', required: true },
    { key: 'outbound.url', label: 'Outbound URL', type: 'url', required: false },
  ],
};

/**
 * A Slack instance stored before `dmPolicy` and `approverAllowlist` existed —
 * the population the defect actually stranded.
 */
const configPredatingTheFields: CatalogInstance & { config?: Record<string, unknown> } = {
  id: 'slack',
  enabled: true,
  status: {
    id: 'slack',
    type: 'slack',
    displayName: 'Slack',
    state: 'connected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  },
  config: { botToken: 'xoxb-stored', streaming: true, label: 'Workspace' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const mockTransport = createMockTransport();
  mockTransport.listMeshAgents = vi
    .fn()
    .mockResolvedValue({ agents: [{ id: 'dorkbot', name: 'DorkBot' }] });
  mockTransport.testRelayAdapterConnection = vi.fn().mockResolvedValue({ ok: true });
  mockTransport.updateRelayAdapterConfig = vi.fn().mockResolvedValue({ ok: true });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={mockTransport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  return { Wrapper, mockTransport };
}

/**
 * Walk past step one.
 *
 * Adding a connection now asks who answers before it asks for any setting, so
 * every assertion about the configure step has to get there first. The single
 * agent the wrapper supplies is chosen automatically; this just presses on.
 */
async function advanceToConfigure() {
  const next = await screen.findByRole('button', { name: /continue/i });
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
}

/** The section a heading introduces, as a scoped query root. */
function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const container = heading.parentElement;
  if (!container) throw new Error(`Section "${name}" has no container`);
  return container;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterSetupWizard — fields no setup step names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a Slack access control the setup step never names', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open onOpenChange={vi.fn()} manifest={slackShapedManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    const accessControl = section('Access Control');
    expect(within(accessControl).getByText('DM Access')).toBeInTheDocument();
    expect(within(accessControl).getByLabelText('Approvers')).toBeInTheDocument();
    expect(within(accessControl).getByLabelText('Channel Overrides')).toBeInTheDocument();
  });

  it('leaves the fields the step does name exactly where they were', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open onOpenChange={vi.fn()} manifest={slackShapedManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    expect(screen.getByLabelText(/bot token/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Stream Responses')).toBeInTheDocument();
    // The step's own fields sit above the section that collects the strays.
    const stepField = screen.getByLabelText('Stream Responses');
    const stray = screen.getByLabelText('Approvers');
    expect(stepField.compareDocumentPosition(stray)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('files strays that name no section of their own under Advanced', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open onOpenChange={vi.fn()} manifest={telegramShapedManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    // First step: the strays are not here — they belong to the last step.
    expect(screen.queryByRole('heading', { name: 'Advanced' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Approvers')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: '123:ABCdef' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Advanced' })).toBeInTheDocument();
    });
    const advanced = section('Advanced');
    expect(within(advanced).getByLabelText('Streaming')).toBeInTheDocument();
    expect(within(advanced).getByLabelText('Approvers')).toBeInTheDocument();
    // The last step still shows the field it names.
    expect(screen.getByText('Replies in Groups')).toBeInTheDocument();
  });

  it('adds no Advanced section to a manifest that has no setup steps', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open onOpenChange={vi.fn()} manifest={steplessManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    expect(screen.queryByRole('heading', { name: 'Advanced' })).not.toBeInTheDocument();
    // Required labels carry a real asterisk node since DOR-651, so the lookup
    // anchors a regex that tolerates it.
    expect(screen.getByLabelText(/^Inbound Subject\*?$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Outbound URL\*?$/)).toBeInTheDocument();
  });

  it('opens a config saved before the field existed on the safe default', () => {
    const { Wrapper } = createWrapper();
    render(
      <AdapterSetupWizard
        open
        onOpenChange={vi.fn()}
        manifest={slackShapedManifest}
        existingInstance={configPredatingTheFields}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByText('Edit Slack')).toBeInTheDocument();
    // Surfacing the control must not move it off the value it already had.
    expect(screen.getByRole('radio', { name: /allowlist only/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /open \(anyone\)/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByLabelText('Approvers')).toHaveValue('');
  });

  it('saves an approver the person types into a previously unreachable field', async () => {
    const { Wrapper, mockTransport } = createWrapper();
    render(
      <AdapterSetupWizard
        open
        onOpenChange={vi.fn()}
        manifest={slackShapedManifest}
        existingInstance={configPredatingTheFields}
      />,
      { wrapper: Wrapper }
    );

    fireEvent.change(screen.getByLabelText('Approvers'), { target: { value: 'U01ABC123' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText(/reachable/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockTransport.updateRelayAdapterConfig).toHaveBeenCalledWith(
        'slack',
        expect.objectContaining({ approverAllowlist: 'U01ABC123', dmPolicy: 'allowlist' })
      );
    });
  });

  it('keeps conditional visibility working for a stray field', async () => {
    const { Wrapper } = createWrapper();
    render(<AdapterSetupWizard open onOpenChange={vi.fn()} manifest={slackShapedManifest} />, {
      wrapper: Wrapper,
    });
    await advanceToConfigure();

    // dmPolicy defaults to allowlist, so the list it gates is on screen.
    expect(screen.getByLabelText('DM Allowlist')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /open \(anyone\)/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText('DM Allowlist')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Approvers')).toBeInTheDocument();
  });
});
