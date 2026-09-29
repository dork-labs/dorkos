/**
 * @vitest-environment jsdom
 *
 * "Found on this computer" (spec `claude-account-ui` §6.9): the Claude account
 * folders the server found, offered below the registered accounts with Add
 * and Dismiss. Rendered through `ClaudeAccountsSection`, which owns the reads
 * and writes, on a mock transport.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { FoundClaudeFolder } from '@dorkos/shared/account-usage';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ClaudeAccountsSection } from '../sections/ClaudeAccountsSection';

vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: true,
    activeTab: 'runtimes',
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
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
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

type Account = NonNullable<ServerConfig['claudeCode']>['accounts'][number];

/** Noon, local time, on a fixed day, so "today" and "yesterday" are stable. */
const NOW = new Date(2026, 8, 27, 12, 0, 0);
const HOURS = 3_600_000;

function account(id: string, path: string): Account {
  return { id, path, label: null, color: '#3b82f6', colorIsDefault: true, isAccountRoot: true };
}

function folder(name: string, extra: Partial<FoundClaudeFolder> = {}): FoundClaudeFolder {
  return {
    path: `/Users/dev/${name}`,
    name,
    lastUsedAt: null,
    orgManaged: false,
    orgMarker: null,
    ...extra,
  };
}

function renderSection({
  accounts = [],
  folders = [],
  updateConfig = vi.fn(async () => undefined),
  dismiss = vi.fn(async () => undefined),
}: {
  accounts?: Account[];
  folders?: FoundClaudeFolder[];
  updateConfig?: (patch: Record<string, unknown>) => Promise<void>;
  dismiss?: (path: string) => Promise<void>;
} = {}) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      claudeCode: { resolvedAccount: '/Users/dev/.claude', inherited: true, accounts },
    }),
    updateConfig,
    getFoundClaudeFolders: vi.fn().mockResolvedValue({ folders }),
    dismissFoundClaudeFolder: dismiss,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<ClaudeAccountsSection />, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
  return transport;
}

/** The found group, once it has loaded. */
async function foundGroup() {
  return screen.findByRole('group', { name: 'Found on this computer' });
}

describe('FoundAccountsGroup in ClaudeAccountsSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('shows nothing when no folder was found', async () => {
    const transport = renderSection({ accounts: [account('a', '/Users/dev/.claude')] });

    await waitFor(() => expect(transport.getFoundClaudeFolders).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Default account')).toBeInTheDocument());
    expect(screen.queryByRole('group', { name: 'Found on this computer' })).toBeNull();
    expect(screen.queryByText('Found on this computer')).toBeNull();
  });

  it.each([0, 1, 2])('offers found folders with %i registered accounts', async (count) => {
    const accounts = [account('a', '/Users/dev/.claude3'), account('b', '/Users/dev/.claude4')];
    renderSection({ accounts: accounts.slice(0, count), folders: [folder('.claude2')] });

    const group = await foundGroup();
    expect(within(group).getByText('.claude2')).toBeInTheDocument();
  });

  it('names each folder, says when it was last used by calendar day, and shows its path', async () => {
    renderSection({
      folders: [
        folder('.claude2', { lastUsedAt: new Date(NOW.getTime() - 2 * HOURS).toISOString() }),
        folder('.claude3', { lastUsedAt: new Date(NOW.getTime() - 24 * HOURS).toISOString() }),
        folder('.claude4', { lastUsedAt: new Date(NOW.getTime() - 48 * HOURS).toISOString() }),
        folder('.claude5'),
      ],
    });

    const group = await foundGroup();
    const rows = within(group).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('.claude2· used today~/.claude2'),
      expect.stringContaining('.claude3· used yesterday~/.claude3'),
      expect.stringContaining('.claude4· used 2 days ago~/.claude4'),
      expect.stringContaining('.claude5~/.claude5'),
    ]);
    expect(within(rows[3]!).queryByText(/used/)).toBeNull();
  });

  it('flags an org-managed folder in words and makes its Add a plain button', async () => {
    renderSection({
      folders: [
        folder('.claude2'),
        folder('.claude-ab1', { orgManaged: true, orgMarker: 'remote-settings.json' }),
      ],
    });

    const group = await foundGroup();
    const [plain, managed] = within(group).getAllByRole('listitem');
    expect(within(managed!).getByText('managed by an organization')).toBeInTheDocument();
    expect(within(plain!).queryByText('managed by an organization')).toBeNull();
    expect(within(group).getByRole('button', { name: 'Add .claude-ab1' })).toHaveAttribute(
      'data-variant',
      'outline'
    );
    expect(within(group).getByRole('button', { name: 'Add .claude2' })).toHaveAttribute(
      'data-variant',
      'default'
    );
  });

  it('adds a folder with the accounts write the add form uses, then reads both lists again', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      accounts: [account('work', '/Users/dev/.claude')],
      folders: [folder('.claude2')],
    });
    const group = await foundGroup();
    const configReads = vi.mocked(transport.getConfig).mock.calls.length;
    const foundReads = vi.mocked(transport.getFoundClaudeFolders).mock.calls.length;

    await user.click(within(group).getByRole('button', { name: 'Add .claude2' }));

    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'work', path: '/Users/dev/.claude', label: null, color: null },
            { id: 'claude2', path: '/Users/dev/.claude2', label: null, color: null },
          ],
          accountsSeen: ['work'],
        },
      },
    });
    await waitFor(() =>
      expect(vi.mocked(transport.getConfig).mock.calls.length).toBeGreaterThan(configReads)
    );
    await waitFor(() =>
      expect(vi.mocked(transport.getFoundClaudeFolders).mock.calls.length).toBeGreaterThan(
        foundReads
      )
    );
  });

  it('dismisses a folder by its path, then reads the found list again', async () => {
    const user = userEvent.setup();
    const transport = renderSection({ folders: [folder('.claude2')] });
    const group = await foundGroup();
    const foundReads = vi.mocked(transport.getFoundClaudeFolders).mock.calls.length;

    await user.click(within(group).getByRole('button', { name: 'Dismiss .claude2' }));

    expect(transport.dismissFoundClaudeFolder).toHaveBeenCalledWith('/Users/dev/.claude2');
    await waitFor(() =>
      expect(vi.mocked(transport.getFoundClaudeFolders).mock.calls.length).toBeGreaterThan(
        foundReads
      )
    );
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('shows a refused Add under the row it belongs to', async () => {
    const user = userEvent.setup();
    renderSection({
      folders: [folder('.claude2'), folder('.claude3')],
      updateConfig: vi
        .fn()
        .mockRejectedValue(new Error('Only a person can change those settings.')),
    });
    const group = await foundGroup();

    await user.click(within(group).getByRole('button', { name: 'Add .claude3' }));

    const alert = await within(group).findByRole('alert');
    expect(alert).toHaveTextContent('Only a person can change those settings.');
    const [first, second] = within(group).getAllByRole('listitem');
    expect(second).toContainElement(alert);
    expect(within(first!).queryByRole('alert')).toBeNull();
  });

  it('shows a refused Dismiss under its row', async () => {
    const user = userEvent.setup();
    renderSection({
      folders: [folder('.claude2')],
      dismiss: vi.fn().mockRejectedValue(new Error('Could not hide that folder. Try again.')),
    });
    const group = await foundGroup();

    await user.click(within(group).getByRole('button', { name: 'Dismiss .claude2' }));

    expect(await within(group).findByRole('alert')).toHaveTextContent(
      'Could not hide that folder. Try again.'
    );
  });
});
