/**
 * @vitest-environment jsdom
 *
 * The Claude Code account card (spec `claude-code-accounts` D6/D7): which
 * account new work bills to, the accounts DorkOS knows about, and what happens
 * when the write is refused.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ClaudeAccountsCard } from '../ui/ClaudeAccountsCard';

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
  // Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const HOME = '/Users/dev/.claude';
const WORK = '/Users/dev/.claude2';

type ClaudeCodeBlock = NonNullable<ServerConfig['claudeCode']>;

function serverConfig(claudeCode: ClaudeCodeBlock): Partial<ServerConfig> {
  return { claudeCode };
}

let updateConfigResult: () => Promise<void> = () => Promise.resolve();

function renderCard(claudeCode: ClaudeCodeBlock) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(serverConfig(claudeCode)),
    updateConfig: vi.fn(() => updateConfigResult()),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<ClaudeAccountsCard />, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  return transport;
}

/** Open the account Select and click one of its options. */
async function chooseOption(user: ReturnType<typeof userEvent.setup>, name: RegExp | string) {
  await user.click(screen.getByRole('combobox', { name: 'Claude Code account' }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name }));
}

describe('ClaudeAccountsCard', () => {
  beforeEach(() => {
    updateConfigResult = () => Promise.resolve();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('shows the resolved default rather than a blank field when no account is chosen', async () => {
    renderCard({ resolvedAccount: HOME, inherited: true, accounts: [] });

    // The client cannot compute this: the server's inherited CLAUDE_CONFIG_DIR is
    // invisible to it, so an unset field would otherwise read as empty (AC8).
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Claude Code account' })).toHaveTextContent(
        'Default (~/.claude)'
      )
    );
  });

  it('writes the chosen account so new work runs on it', async () => {
    const user = userEvent.setup();
    const transport = renderCard({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        { path: HOME, label: 'Personal', isAccountRoot: true },
        { path: WORK, label: 'Acme Corp', isAccountRoot: true },
      ],
    });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

    await chooseOption(user, 'Acme Corp');
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: { claudeCode: { activeAccount: WORK } },
    });
  });

  it('writes activeAccount: null when Default is chosen', async () => {
    const user = userEvent.setup();
    const transport = renderCard({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [{ path: WORK, label: 'Acme Corp', isAccountRoot: true }],
    });
    await waitFor(() => expect(screen.getByTestId('claude-account-row')).toBeInTheDocument());

    await chooseOption(user, 'Default');
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: { claudeCode: { activeAccount: null } },
    });
  });

  it('offers the account in use even when it was never registered', async () => {
    // `activeAccount` can be set by hand in `~/.dork/config.json` (the
    // configuration guide shows exactly that) without appearing under
    // `accounts`. A picker built from the roster alone would then have no option
    // matching its own value and would render blank.
    renderCard({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [{ path: HOME, label: 'Personal', isAccountRoot: true }],
    });

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Claude Code account' })).toHaveTextContent(
        '.claude2'
      )
    );
  });

  it('registers a new account, and an empty name is stored as no name at all', async () => {
    const user = userEvent.setup();
    const transport = renderCard({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [{ path: HOME, label: 'Personal', isAccountRoot: true }],
    });
    await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Account folder'), WORK);
    // Whitespace only: `.trim() || null` keeps a blank name out of the config.
    await user.type(screen.getByLabelText('Name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: {
        claudeCode: {
          accounts: [
            { path: HOME, label: 'Personal' },
            { path: WORK, label: null },
          ],
        },
      },
    });
  });

  it("refuses a path that is not the folder's full path, and says what to type", async () => {
    const user = userEvent.setup();
    const transport = renderCard({ resolvedAccount: HOME, inherited: true, accounts: [] });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Claude Code account' })).toBeInTheDocument()
    );

    // Nothing between this field and the config file expands `~`, so a shorthand
    // path registers a folder that is not there — and that junk entry still
    // counts towards "more than one account", turning badges on for every row.
    await user.type(screen.getByLabelText('Account folder'), '~/.claude2');

    expect(screen.getByTestId('claude-account-not-absolute')).toHaveTextContent(
      "Use the folder's full path"
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('accepts a full path with no complaint', async () => {
    const user = userEvent.setup();
    renderCard({ resolvedAccount: HOME, inherited: true, accounts: [] });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Claude Code account' })).toBeInTheDocument()
    );

    await user.type(screen.getByLabelText('Account folder'), WORK);

    expect(screen.queryByTestId('claude-account-not-absolute')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('refuses to add the same folder twice', async () => {
    const user = userEvent.setup();
    renderCard({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [{ path: WORK, label: 'Acme Corp', isAccountRoot: true }],
    });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Account folder'), WORK);

    expect(screen.getByTestId('claude-account-duplicate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('releases the active account when that account is removed', async () => {
    const user = userEvent.setup();
    const transport = renderCard({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [
        { path: HOME, label: 'Personal', isAccountRoot: true },
        { path: WORK, label: 'Acme Corp', isAccountRoot: true },
      ],
    });
    await waitFor(() => expect(screen.getAllByTestId('claude-account-row')).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Remove Acme Corp' }));

    // Removing the account work runs on must stop the work running there too,
    // or DorkOS keeps billing an account the operator just took off the list.
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: {
        claudeCode: { accounts: [{ path: HOME, label: 'Personal' }], activeAccount: null },
      },
    });
  });

  it('leaves the active account alone when a different account is removed', async () => {
    const user = userEvent.setup();
    const transport = renderCard({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [
        { path: HOME, label: 'Personal', isAccountRoot: true },
        { path: WORK, label: 'Acme Corp', isAccountRoot: true },
      ],
    });
    await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Remove Personal' }));

    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: { claudeCode: { accounts: [{ path: WORK, label: 'Acme Corp' }] } },
    });
  });

  it('says plainly when a registered folder is not a usable account', async () => {
    renderCard({
      resolvedAccount: HOME,
      inherited: true,
      // `isAccountRoot` is the STRUCTURAL check (spec D4): a folder that really
      // exists but holds no `projects/` reports false, so the copy must not
      // claim the folder is missing.
      accounts: [{ path: WORK, label: 'Acme Corp', isAccountRoot: false }],
    });

    await waitFor(() =>
      expect(screen.getByTestId('claude-account-not-ready')).toHaveTextContent(
        'does not look like a Claude Code account yet'
      )
    );
  });

  it('shows nothing of the sort when every registered folder is usable', async () => {
    renderCard({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [{ path: WORK, label: 'Acme Corp', isAccountRoot: true }],
    });

    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.queryByTestId('claude-account-not-ready')).not.toBeInTheDocument();
  });

  it('surfaces a refused write instead of appearing to succeed', async () => {
    const user = userEvent.setup();
    updateConfigResult = () =>
      Promise.reject(
        Object.assign(new Error('Only a person can change those settings'), {
          status: 403,
          code: 'operator_only_config',
        })
      );
    renderCard({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        { path: HOME, label: 'Personal', isAccountRoot: true },
        { path: WORK, label: 'Acme Corp', isAccountRoot: true },
      ],
    });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

    await chooseOption(user, 'Acme Corp');

    // Both leaves are operator-only, so under Require login this 403 is a real
    // outcome. Red when the failure is swallowed and the card looks unchanged.
    await waitFor(() =>
      expect(screen.getByTestId('claude-account-error')).toHaveTextContent(
        'Only a person can change those settings'
      )
    );
  });
});
