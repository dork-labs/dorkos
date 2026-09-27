/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import { AppList } from '../ui/app-list/AppList';
import type { YourAppRow } from '../lib/app-list';
import type { AppListData } from '../model/use-app-list';

afterEach(cleanup);

function service(
  serviceSlug: string,
  displayName: string,
  category: ConnectorCatalogService['category'],
  uses: { account?: boolean; chat?: boolean } = { account: true }
): ConnectorCatalogService {
  return {
    serviceSlug,
    displayName,
    iconKey: serviceSlug,
    description: `What agents do with ${displayName}.`,
    category,
    popular: true,
    intents: [
      ...(uses.chat
        ? [{ kind: 'messages' as const, displayName: 'Bot', relayAdapterType: serviceSlug }]
        : []),
      ...(uses.account ? [{ kind: 'account' as const, displayName: 'Account', routes: [] }] : []),
    ],
  };
}

const APPS = [
  service('gmail', 'Gmail', 'email'),
  service('linear', 'Linear', 'tasks'),
  service('telegram', 'Telegram', 'chat', { chat: true }),
  service('webhook', 'Webhook', 'developer', { chat: true }),
];

const ROWS: YourAppRow[] = [
  {
    id: 'c-notion',
    kind: 'account',
    name: 'Notion',
    iconKey: 'notion',
    account: 'Acme',
    identity: null,
    detail: 'Signed out. Agents can’t use it until you sign in again.',
    tone: 'broken',
    action: 'sign-in-again',
    waiting: 0,
  },
  {
    id: 'telegram-1',
    kind: 'chat',
    name: 'Telegram',
    iconKey: 'telegram',
    account: '@lifeos_bot',
    identity: null,
    detail: '@lifeos_bot · DorkBot answers',
    tone: 'ready',
    action: null,
    waiting: 1,
  },
];

function data(over: Partial<AppListData> = {}, relayEnabled = true): AppListData {
  return {
    yours: [],
    allYours: [],
    available: APPS,
    services: new Map(APPS.map((app) => [app.serviceSlug, app])),
    agentNames: {},
    chatApps: [],
    owned: { accounts: new Set(), chatApps: new Set() },
    yoursLoading: false,
    yoursError: false,
    yoursRefreshing: false,
    retryYours: vi.fn(),
    catalog: {
      data: {
        pages: [
          {
            services: APPS,
            warnings: [],
            appConnections: {
              ways: [],
              newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
            },
          },
        ],
      },
      isPending: false,
      isError: false,
      hasNextPage: false,
    } as unknown as AppListData['catalog'],
    relay: {
      enabled: relayEnabled,
      isLoading: false,
      isError: false,
      isRetrying: false,
      retry: vi.fn(),
    },
    chatAppsError: false,
    retryChatApps: vi.fn(),
    ...over,
  };
}

function renderList(listData: AppListData, query = '') {
  const handlers = {
    onQueryChange: vi.fn(),
    onOpenRow: vi.fn(),
    onRowAction: vi.fn(),
    onConnect: vi.fn(),
  };
  render(<AppList query={query} data={listData} {...handlers} />);
  return handlers;
}

describe('AppList', () => {
  it('on a first visit shows no "Yours" at all: the app list is the empty state', () => {
    renderList(data());
    expect(screen.queryByRole('heading', { name: 'Yours' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All apps' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
  });

  it('keeps developer tools in their own small group, set up rather than connected', () => {
    renderList(data());
    const developers = screen.getByRole('region', { name: 'For developers' });
    expect(within(developers).getByRole('button', { name: 'Set up Webhook' })).toBeInTheDocument();
    const all = screen.getByTestId('all-apps-list');
    expect(within(all).queryByText('Webhook')).not.toBeInTheDocument();
  });

  it('filters by shelf with the chips, and every chip is a pressed-state button', async () => {
    const user = userEvent.setup();
    renderList(data());
    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-pressed', 'true');
    const all = screen.getByTestId('all-apps-list');
    expect(within(all).getByText('Linear')).toBeInTheDocument();
    expect(within(all).queryByText('Gmail')).not.toBeInTheDocument();
  });

  it('opens a row’s panel, and runs its one action from its own button', async () => {
    const user = userEvent.setup();
    const handlers = renderList(data({ yours: ROWS, allYours: ROWS }));

    expect(screen.getByRole('heading', { name: 'Yours' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in again: Notion' }));
    expect(handlers.onRowAction).toHaveBeenCalledWith(ROWS[0]);
    expect(handlers.onOpenRow).not.toHaveBeenCalled();

    const telegram = screen.getByTestId('app-row-telegram-1');
    expect(telegram).toHaveTextContent('1 waiting');
    expect(telegram).toHaveTextContent('Chat');
    await user.click(within(telegram).getByRole('button'));
    expect(handlers.onOpenRow).toHaveBeenCalledWith(ROWS[1]);
  });

  it('while searching, drops the chips and lists every match', () => {
    renderList(data({ available: [APPS[1]] }), 'lin');
    expect(screen.queryByRole('group', { name: 'Show apps by kind' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Apps' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Linear' })).toBeInTheDocument();
  });

  it('says why a search finds nothing while no way to reach apps is set up', () => {
    renderList(data({ available: [] }), 'zzz');
    expect(screen.getByText('No app matches “zzz”')).toBeInTheDocument();
    expect(screen.getByText(/Only popular apps are listed/)).toBeInTheDocument();
  });

  it('with chat apps off, says so in one quiet line and offers no dead Connect', () => {
    const handlers = renderList(data({}, false));
    expect(screen.getByTestId('chat-apps-off')).toHaveTextContent('DORKOS_RELAY_ENABLED=true');
    expect(screen.queryByRole('button', { name: 'Connect Telegram' })).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-app-telegram')).toHaveTextContent('Turned off');
    expect(handlers.onConnect).not.toHaveBeenCalled();
  });

  it('says it couldn’t load your apps, with a retry, rather than an empty list', async () => {
    const user = userEvent.setup();
    const listData = data({ yoursError: true });
    renderList(listData);
    expect(screen.getByText('Couldn’t load your apps')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(listData.retryYours).toHaveBeenCalled();
  });
});
