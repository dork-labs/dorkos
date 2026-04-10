/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { CatalogEntry, AdapterBinding } from '@dorkos/shared/relay-schemas';

let mockRelayEnabled = true;
let mockCatalogData: CatalogEntry[] = [];
let mockBindingsData: AdapterBinding[] = [];
let mockIsLoading = false;
const mockToggleAdapter = vi.fn();

// Mock relay entity hooks — return plain objects, no internal useQuery
vi.mock('@/layers/entities/relay', () => ({
  useExternalAdapterCatalog: () => ({ data: mockCatalogData, isLoading: mockIsLoading }),
  useToggleAdapter: () => ({ mutate: mockToggleAdapter }),
  useRelayEnabled: () => mockRelayEnabled,
}));

// Mock binding entity hooks
vi.mock('@/layers/entities/binding', () => ({
  useBindings: () => ({ data: mockBindingsData }),
}));

// Mock relay feature components to avoid deep dependencies
vi.mock('@/layers/features/relay', () => ({
  AdapterSetupWizard: () => <div data-testid="adapter-setup-wizard" />,
  AdapterIcon: ({ adapterType }: { adapterType: string }) => (
    <span data-testid="adapter-icon">{adapterType}</span>
  ),
  CatalogCard: ({ manifest, onAdd }: { manifest: { displayName: string }; onAdd: () => void }) => (
    <div data-testid={`catalog-card-${manifest.displayName.toLowerCase()}`}>
      <span>{manifest.displayName}</span>
      <button onClick={onAdd}>Add</button>
    </div>
  ),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  mockCatalogData = [];
  mockBindingsData = [];
  mockIsLoading = false;
  mockRelayEnabled = true;
  mockToggleAdapter.mockReset();
});

function makeCatalogEntry(
  type: string,
  displayName: string,
  instances: CatalogEntry['instances']
): CatalogEntry {
  return {
    manifest: {
      type,
      displayName,
      description: `${displayName} adapter`,
      category: 'messaging',
      builtin: true,
      configFields: [],
      multiInstance: false,
    },
    instances,
  };
}

import { ChannelsTab } from '../ui/ChannelsTab';

describe('ChannelsTab', () => {
  it('shows relay disabled message when relay is off', () => {
    mockRelayEnabled = false;

    render(<ChannelsTab />);

    expect(screen.getByText('Relay is disabled')).toBeInTheDocument();
    expect(
      screen.getByText('Enable the Relay message bus to manage channels here')
    ).toBeInTheDocument();
  });

  it('shows loading skeletons while catalog is loading', () => {
    mockIsLoading = true;

    const { container } = render(<ChannelsTab />);

    // Skeleton elements are rendered (3 skeleton placeholders)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBe(3);
  });

  it('shows empty state when no channels are configured', () => {
    mockCatalogData = [];

    render(<ChannelsTab />);

    expect(screen.getByText('No channels configured')).toBeInTheDocument();
    expect(
      screen.getByText('Add a channel below to connect agents to external platforms')
    ).toBeInTheDocument();
  });

  it('renders channel rows for configured instances', () => {
    mockCatalogData = [
      makeCatalogEntry('telegram', 'Telegram', [
        {
          id: 'tg-1',
          enabled: true,
          label: 'Bot Alpha',
          status: {
            id: 'tg-1',
            type: 'telegram',
            displayName: 'Telegram',
            state: 'connected',
            messageCount: { inbound: 5, outbound: 3 },
            errorCount: 0,
          },
        },
      ]),
    ];

    render(<ChannelsTab />);

    expect(screen.getByText('Bot Alpha')).toBeInTheDocument();
  });

  it('renders multiple instances from different adapter types', () => {
    mockCatalogData = [
      makeCatalogEntry('telegram', 'Telegram', [
        {
          id: 'tg-1',
          enabled: true,
          label: 'TG Bot',
          status: {
            id: 'tg-1',
            type: 'telegram',
            displayName: 'Telegram',
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          },
        },
      ]),
      makeCatalogEntry('slack', 'Slack', [
        {
          id: 'slack-1',
          enabled: false,
          label: 'Slack Workspace',
          status: {
            id: 'slack-1',
            type: 'slack',
            displayName: 'Slack',
            state: 'disconnected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          },
        },
      ]),
    ];

    render(<ChannelsTab />);

    expect(screen.getByText('TG Bot')).toBeInTheDocument();
    expect(screen.getByText('Slack Workspace')).toBeInTheDocument();
  });

  it('calls toggleAdapter when a channel switch is toggled', async () => {
    const user = userEvent.setup();
    mockCatalogData = [
      makeCatalogEntry('telegram', 'Telegram', [
        {
          id: 'tg-1',
          enabled: true,
          label: 'My Bot',
          status: {
            id: 'tg-1',
            type: 'telegram',
            displayName: 'Telegram',
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          },
        },
      ]),
    ];

    render(<ChannelsTab />);

    const toggle = screen.getByRole('switch', { name: /my bot enabled/i });
    await user.click(toggle);

    expect(mockToggleAdapter).toHaveBeenCalledWith({ id: 'tg-1', enabled: false });
  });

  it('renders Available Channels section for unconfigured adapter types', () => {
    mockCatalogData = [
      makeCatalogEntry('telegram', 'Telegram', []),
      makeCatalogEntry('slack', 'Slack', []),
    ];

    render(<ChannelsTab />);

    expect(screen.getByText('Available Channels')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-card-telegram')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-card-slack')).toBeInTheDocument();
  });

  it('hides Available Channels when all types are configured (non-multiInstance)', () => {
    mockCatalogData = [
      makeCatalogEntry('telegram', 'Telegram', [
        {
          id: 'tg-1',
          enabled: true,
          status: {
            id: 'tg-1',
            type: 'telegram',
            displayName: 'Telegram',
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          },
        },
      ]),
    ];

    render(<ChannelsTab />);

    expect(screen.queryByText('Available Channels')).not.toBeInTheDocument();
  });

  it('shows multiInstance adapters in Available Channels even when they have instances', () => {
    mockCatalogData = [
      {
        manifest: {
          type: 'webhook',
          displayName: 'Webhook',
          description: 'HTTP webhook adapter',
          category: 'messaging',
          builtin: true,
          configFields: [],
          multiInstance: true,
        },
        instances: [
          {
            id: 'wh-1',
            enabled: true,
            status: {
              id: 'wh-1',
              type: 'webhook',
              displayName: 'Webhook',
              state: 'connected',
              messageCount: { inbound: 0, outbound: 0 },
              errorCount: 0,
            },
          },
        ],
      },
    ];

    render(<ChannelsTab />);

    expect(screen.getByText('Available Channels')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-card-webhook')).toBeInTheDocument();
  });

  it('passes binding count to ChannelSettingRow', () => {
    mockCatalogData = [
      makeCatalogEntry('telegram', 'Telegram', [
        {
          id: 'tg-1',
          enabled: true,
          label: 'My Bot',
          status: {
            id: 'tg-1',
            type: 'telegram',
            displayName: 'Telegram',
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          },
        },
      ]),
    ];
    mockBindingsData = [
      {
        id: 'b1',
        adapterId: 'tg-1',
        agentId: 'agent-1',
        sessionStrategy: 'per-chat',
        canInitiate: true,
        canReply: true,
        canReceive: true,
      },
      {
        id: 'b2',
        adapterId: 'tg-1',
        agentId: 'agent-2',
        sessionStrategy: 'per-chat',
        canInitiate: true,
        canReply: true,
        canReceive: true,
      },
    ] as AdapterBinding[];

    render(<ChannelsTab />);

    // The binding count is rendered in ChannelSettingRow's metadata line
    expect(screen.getByText('2 agents')).toBeInTheDocument();
  });

  it('excludes internal adapters from configured channels', () => {
    // useExternalAdapterCatalog pre-filters internal adapters, so the mock
    // returns only external entries — verifying that the component uses the
    // shared hook rather than raw useAdapterCatalog.
    mockCatalogData = [
      makeCatalogEntry('telegram', 'Telegram', [
        {
          id: 'tg-1',
          enabled: true,
          label: 'My Bot',
          status: {
            id: 'tg-1',
            type: 'telegram',
            displayName: 'Telegram',
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          },
        },
      ]),
    ];

    render(<ChannelsTab />);

    expect(screen.getByText('My Bot')).toBeInTheDocument();
    // Internal adapters never reach the component — the hook filters them.
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });

  it('excludes internal adapters from Available Channels', () => {
    // When only internal adapters exist, the hook returns an empty array.
    // The component should show the empty state, not the Available Channels section.
    mockCatalogData = [];

    render(<ChannelsTab />);

    expect(screen.queryByText('Available Channels')).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-card-claude code')).not.toBeInTheDocument();
  });
});
