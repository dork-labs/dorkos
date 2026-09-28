/**
 * @vitest-environment jsdom
 *
 * The Claude Code billing-account section (spec `claude-code-accounts` D6/D7,
 * relocated into the Claude Code runtime card by `runtimes-settings-redesign`):
 * which account new work bills to, the accounts DorkOS knows about, and what
 * happens when the write is refused.
 *
 * Every case here was carried over from the retired accounts card's test
 * unchanged except for the extra click that opens the add-account form, which
 * is now a quiet affordance in the section heading rather than a permanent row.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { createMockAccountUsage, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, seedAccountUsage, useExtensionRegistry } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ClaudeAccountsSection } from '../sections/ClaudeAccountsSection';

const mockSetTab = vi.fn();
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: true,
    activeTab: 'runtimes',
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: mockSetTab,
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

function renderSection(
  claudeCode: ClaudeCodeBlock,
  { usage = [] }: { usage?: AccountUsage[] } = {}
) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(serverConfig(claudeCode)),
    updateConfig: vi.fn(() => updateConfigResult()),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The card fetches usage; the section only reads what is cached.
  seedAccountUsage(queryClient, usage);
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

/** Open the account Select and click one of its options. */
async function chooseOption(user: ReturnType<typeof userEvent.setup>, name: RegExp | string) {
  await user.click(screen.getByRole('combobox', { name: 'Default account' }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name }));
}

/** Reveal the add-account fields, which sit behind the quiet heading affordance. */
async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add account' }));
  await screen.findByLabelText('Account folder');
}

describe('ClaudeAccountsSection', () => {
  beforeEach(() => {
    updateConfigResult = () => Promise.resolve();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('renders as a boxed sub-section headed "Billing account"', async () => {
    renderSection({ resolvedAccount: HOME, inherited: true, accounts: [] });

    // The section lives INSIDE the Claude Code runtime card now, so its own
    // heading is what tells an operator which part of the card they are in.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Billing account' })).toBeInTheDocument()
    );
    // No card chrome of its own: the runtime card supplies that.
    expect(screen.getByTestId('claude-accounts-section')).toBeInTheDocument();
    // The add fields stay out of the way until asked for.
    expect(screen.queryByLabelText('Account folder')).not.toBeInTheDocument();
  });

  it('calls the select the DEFAULT account, and says what can overrule it', async () => {
    // The account is a three-rung ladder now (spec `billing-account-ladder`):
    // an agent or a single session can overrule this. Naming the row "Account"
    // would present the bottom rung as the answer, which is how an operator ends
    // up billing the wrong client and never knowing why.
    renderSection({ resolvedAccount: HOME, inherited: true, accounts: [] });

    await waitFor(() => expect(screen.getByText('Default account')).toBeInTheDocument());
    expect(
      screen.getByText(
        'New sessions bill this account unless the agent or the session picks another.'
      )
    ).toBeInTheDocument();
  });

  it('shows the resolved default rather than a blank field when no account is chosen', async () => {
    renderSection({ resolvedAccount: HOME, inherited: true, accounts: [] });

    // The client cannot compute this: the server's inherited CLAUDE_CONFIG_DIR is
    // invisible to it, so an unset field would otherwise read as empty (AC8).
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Default account' })).toHaveTextContent(
        'Default (~/.claude)'
      )
    );
  });

  it('writes the chosen account so new work runs on it', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        {
          id: 'personal',
          path: HOME,
          label: 'Personal',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

    await chooseOption(user, 'Acme Corp');
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: { claudeCode: { defaultAccount: WORK } },
    });
  });

  it('writes defaultAccount: null when Default is chosen', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getByTestId('claude-account-row')).toBeInTheDocument());

    await chooseOption(user, 'Default');
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: { claudeCode: { defaultAccount: null } },
    });
  });

  it('offers the account in use even when it was never registered', async () => {
    // `defaultAccount` can be set by hand in `~/.dork/config.json` (the
    // configuration guide shows exactly that) without appearing under
    // `accounts`. A picker built from the roster alone would then have no option
    // matching its own value and would render blank.
    renderSection({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [
        {
          id: 'personal',
          path: HOME,
          label: 'Personal',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Default account' })).toHaveTextContent(
        '.claude2'
      )
    );
  });

  it('registers a new account, and an empty name is stored as no name at all', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        {
          id: 'personal',
          path: HOME,
          label: 'Personal',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument());

    await openAddForm(user);
    await user.type(screen.getByLabelText('Account folder'), WORK);
    // Whitespace only: `.trim() || null` keeps a blank name out of the config.
    await user.type(screen.getByLabelText('Name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'personal', path: HOME, label: 'Personal', color: null },
            // The new account's stable reference, minted from its folder name
            // because the operator typed only whitespace for a label.
            { id: 'claude2', path: WORK, label: null, color: null },
          ],
          // What the screen showed, so the server removes only those it drops.
          accountsSeen: ['personal'],
        },
      },
    });
  });

  it('never mints an id a LATER row already owns', async () => {
    // A half-migrated registry: the first row has no id yet, the second already
    // holds the id that row's label slugifies to. Reserving ids as the walk goes
    // would hand both rows `acme-corp` — one account unreachable, and a patch
    // the server now refuses outright.
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        // Two labels that slugify to the SAME id, only one of which has been
        // assigned one yet.
        {
          id: null,
          path: HOME,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
        {
          id: 'acme-corp',
          path: WORK,
          label: 'ACME corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getAllByTestId('claude-account-row')).toHaveLength(2));

    // The add path rewrites the WHOLE list, so both rows go through the mint.
    await openAddForm(user);
    await user.type(screen.getByLabelText('Account folder'), '/Users/dev/.claude9');
    await user.type(screen.getByLabelText('Name'), 'Third');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const patch = vi.mocked(transport.updateConfig).mock.calls[0]![0] as {
      runtimes: { claudeCode: { accounts: { id: string }[] } };
    };
    const ids = patch.runtimes.claudeCode.accounts.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The row that already owns `acme-corp` keeps it; the un-migrated row takes
    // the next free spelling rather than colliding with it.
    expect(ids).toEqual(['acme-corp-2', 'acme-corp', 'third']);
  });

  it('refuses a path that is not the folder’s full path, and says what to type', async () => {
    const user = userEvent.setup();
    const transport = renderSection({ resolvedAccount: HOME, inherited: true, accounts: [] });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Default account' })).toBeInTheDocument()
    );

    // Nothing between this field and the config file expands `~`, so a shorthand
    // path registers a folder that is not there — and that junk entry still
    // counts towards "more than one account", turning badges on for every row.
    await openAddForm(user);
    await user.type(screen.getByLabelText('Account folder'), '~/.claude2');

    expect(screen.getByTestId('claude-account-not-absolute')).toHaveTextContent(
      'Use the folder’s full path'
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('accepts a full path with no complaint', async () => {
    const user = userEvent.setup();
    renderSection({ resolvedAccount: HOME, inherited: true, accounts: [] });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Default account' })).toBeInTheDocument()
    );

    await openAddForm(user);
    await user.type(screen.getByLabelText('Account folder'), WORK);

    expect(screen.queryByTestId('claude-account-not-absolute')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('refuses to add the same folder twice', async () => {
    const user = userEvent.setup();
    renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

    await openAddForm(user);
    await user.type(screen.getByLabelText('Account folder'), WORK);

    expect(screen.getByTestId('claude-account-duplicate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('releases the active account when that account is removed', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [
        {
          id: 'personal',
          path: HOME,
          label: 'Personal',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getAllByTestId('claude-account-row')).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Remove Acme Corp' }));

    // Removing the account work runs on must stop the work running there too,
    // or DorkOS keeps billing an account the operator just took off the list.
    // One patch, both leaves: a second request could land after a reload that
    // already re-read the old active account.
    expect(transport.updateConfig).toHaveBeenCalledTimes(1);
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: {
        claudeCode: {
          accounts: [{ id: 'personal', path: HOME, label: 'Personal', color: null }],
          accountsSeen: ['personal', 'acme-corp'],
          defaultAccount: null,
        },
      },
    });
  });

  it('leaves the active account alone when a different account is removed', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: WORK,
      inherited: false,
      accounts: [
        {
          id: 'personal',
          path: HOME,
          label: 'Personal',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
        // A color the operator stored, so the write must carry it back unchanged.
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#12ab9f',
          colorIsDefault: false,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('Personal')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Remove Personal' }));

    expect(transport.updateConfig).toHaveBeenCalledTimes(1);
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: {
        claudeCode: {
          accounts: [{ id: 'acme-corp', path: WORK, label: 'Acme Corp', color: '#12ab9f' }],
          accountsSeen: ['personal', 'acme-corp'],
        },
      },
    });
  });

  it('says plainly when a registered folder is not a usable account', async () => {
    renderSection({
      resolvedAccount: HOME,
      inherited: true,
      // `isAccountRoot` is the STRUCTURAL check (spec D4): a folder that really
      // exists but holds no `projects/` reports false, so the copy must not
      // claim the folder is missing.
      accounts: [
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: false,
        },
      ],
    });

    await waitFor(() =>
      expect(screen.getByTestId('claude-account-not-ready')).toHaveTextContent(
        'does not look like a Claude Code account yet'
      )
    );
  });

  it('shows nothing of the sort when every registered folder is usable', async () => {
    renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
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
    renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [
        {
          id: 'personal',
          path: HOME,
          label: 'Personal',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
        {
          id: 'acme-corp',
          path: WORK,
          label: 'Acme Corp',
          color: '#3b82f6',
          colorIsDefault: true,
          isAccountRoot: true,
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

    await chooseOption(user, 'Acme Corp');

    // Both leaves are operator-only, so under Require login this 403 is a real
    // outcome. Red when the failure is swallowed and the section looks unchanged.
    await waitFor(() =>
      expect(screen.getByTestId('claude-account-error')).toHaveTextContent(
        'Only a person can change those settings'
      )
    );
  });
});

const THIRD = '/Users/dev/.claude3';

/** A registered account row, `n` from 1, on its default color. */
function row(id: string, path: string, label: string | null, over: Partial<Account> = {}): Account {
  return {
    id,
    path,
    label,
    color: '#2f7be0',
    colorIsDefault: true,
    isAccountRoot: true,
    ...over,
  };
}

type Account = ClaudeCodeBlock['accounts'][number];

const PERSONAL = row('personal', HOME, 'Personal');
const ACME = row('acme-corp', WORK, 'Acme Corp', { color: '#1d8a4a' });
const CLIENT = row('client', THIRD, 'Client', { color: '#0d9488', colorIsDefault: false });

function usageFor(accountId: string, path: string, over: Partial<AccountUsage> = {}) {
  return createMockAccountUsage({ accountId, path, label: null, ...over });
}

describe('ClaudeAccountsSection: usage, colors and the Flow note', () => {
  beforeEach(() => {
    updateConfigResult = () => Promise.resolve();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    useExtensionRegistry.setState({
      slots: { ...useExtensionRegistry.getState().slots, 'settings.tabs': [] },
    });
  });

  it('shows the one account\'s bars under "Billing account", labelled with the account', async () => {
    renderSection(
      { resolvedAccount: WORK, inherited: false, accounts: [ACME] },
      { usage: [usageFor('acme-corp', WORK)] }
    );
    const bars = await screen.findAllByRole('img', { name: /used/ });
    expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^5-hour window 40% used/),
      expect.stringMatching(/^Weekly 72% used/),
    ]);
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
  });

  it("labels the implicit account's bars with its folder when nothing is registered", async () => {
    renderSection(
      { resolvedAccount: HOME, inherited: true, accounts: [] },
      { usage: [usageFor('default', HOME)] }
    );
    expect(await screen.findByText('.claude')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Weekly 72% used/ })).toBeInTheDocument();
  });

  it('draws a window with no reading as unknown, never as an empty bar', async () => {
    renderSection(
      { resolvedAccount: WORK, inherited: false, accounts: [ACME] },
      {
        usage: [
          usageFor('acme-corp', WORK, {
            windows: [createMockAccountUsage().windows[1]!],
          }),
        ],
      }
    );
    const unknown = await screen.findByRole('img', { name: '5-hour window usage unknown' });
    expect(unknown.querySelector('[data-tone="unknown"]')).not.toBeNull();
    expect(unknown.querySelector('[data-slot="usage-fill"]')).toBeNull();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it.each([
    ['no', [] as Account[]],
    ['one', [ACME]],
  ])('shows no dots or color control with %s registered account', async (_, accounts) => {
    renderSection({ resolvedAccount: HOME, inherited: true, accounts });
    await screen.findByText('Default account');
    expect(screen.queryByRole('button', { name: /^Color for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /^5h/ })).not.toBeInTheDocument();
  });

  it('gives each of two accounts a color control and compact 5h and wk bars', async () => {
    renderSection(
      { resolvedAccount: HOME, inherited: true, accounts: [PERSONAL, ACME] },
      { usage: [usageFor('personal', HOME), usageFor('acme-corp', WORK)] }
    );
    expect(await screen.findByRole('button', { name: 'Color for Personal' })).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    );
    expect(screen.getByRole('button', { name: 'Color for Acme Corp' })).toBeInTheDocument();
    // The reset time lives in the bar's tooltip, and in its accessible name.
    expect(screen.getAllByRole('img', { name: /^5h 40% used, resets / })).toHaveLength(2);
    expect(screen.getAllByRole('img', { name: /^wk 72% used, resets / })).toHaveLength(2);
    // The block under the heading is for one account only.
    expect(screen.queryByRole('img', { name: /^5-hour window/ })).not.toBeInTheDocument();
  });

  it('opens a radio group of the 8 palette colors plus Default, with the current one checked', async () => {
    const user = userEvent.setup();
    renderSection({ resolvedAccount: HOME, inherited: true, accounts: [PERSONAL, CLIENT] });
    await user.click(await screen.findByRole('button', { name: 'Color for Personal' }));
    const group = await screen.findByRole('radiogroup', { name: 'Color for Personal' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      'blue',
      'green',
      'amber',
      'purple',
      'pink',
      'teal',
      'indigo',
      'stone',
      'Default',
    ]);
    expect(within(group).getByRole('radio', { name: 'Default' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Color for Client' }));
    const clientGroup = await screen.findByRole('radiogroup', { name: 'Color for Client' });
    expect(within(clientGroup).getByRole('radio', { name: 'teal' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('writes the chosen color with every other row unchanged and the ids the screen showed', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [PERSONAL, ACME, CLIENT],
    });
    await user.click(await screen.findByRole('button', { name: 'Color for Acme Corp' }));
    await user.click(await screen.findByRole('radio', { name: 'teal' }));

    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'personal', path: HOME, label: 'Personal', color: null },
            { id: 'acme-corp', path: WORK, label: 'Acme Corp', color: '#0d9488' },
            { id: 'client', path: THIRD, label: 'Client', color: '#0d9488' },
          ],
          accountsSeen: ['personal', 'acme-corp', 'client'],
        },
      },
    });
    // Choosing closes the popover and hands focus back to the dot.
    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Color for Acme Corp' })).toHaveFocus()
    );
  });

  it('writes null when Default is chosen', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [PERSONAL, CLIENT],
    });
    await user.click(await screen.findByRole('button', { name: 'Color for Client' }));
    await user.click(await screen.findByRole('radio', { name: 'Default' }));
    expect(vi.mocked(transport.updateConfig).mock.calls[0]![0]).toMatchObject({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'personal', color: null },
            { id: 'client', color: null },
          ],
        },
      },
    });
  });

  it('moves between swatches with the arrow keys and chooses with Enter', async () => {
    const user = userEvent.setup();
    const transport = renderSection({
      resolvedAccount: HOME,
      inherited: true,
      accounts: [PERSONAL, CLIENT],
    });
    await user.click(await screen.findByRole('button', { name: 'Color for Client' }));
    const teal = await screen.findByRole('radio', { name: 'teal' });
    teal.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'indigo' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'pink' })).toHaveFocus();
    expect(transport.updateConfig).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(vi.mocked(transport.updateConfig).mock.calls[0]![0]).toMatchObject({
      runtimes: { claudeCode: { accounts: [{ color: null }, { color: '#d6336c' }] } },
    });
  });

  it('shows a refused color write as an alert', async () => {
    const user = userEvent.setup();
    updateConfigResult = () => Promise.reject(new Error('Only a person can change those settings'));
    renderSection({ resolvedAccount: HOME, inherited: true, accounts: [PERSONAL, ACME] });
    await user.click(await screen.findByRole('button', { name: 'Color for Personal' }));
    await user.click(await screen.findByRole('radio', { name: 'pink' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a person can change those settings'
    );
  });

  describe('the Flow note', () => {
    function registerFlowTab() {
      useExtensionRegistry.getState().register('settings.tabs', {
        id: 'flow:fleet',
        label: 'Flow',
        icon: (() => null) as never,
        component: () => null,
      });
    }

    it('is absent with two accounts and no Flow tab', async () => {
      renderSection({ resolvedAccount: HOME, inherited: true, accounts: [PERSONAL, ACME] });
      await screen.findByRole('button', { name: 'Color for Personal' });
      expect(screen.queryByText(/Flow uses these accounts/)).not.toBeInTheDocument();
    });

    it('is absent with one account even when the Flow tab is there', async () => {
      registerFlowTab();
      renderSection({ resolvedAccount: HOME, inherited: true, accounts: [ACME] });
      await screen.findByText('Default account');
      expect(screen.queryByText(/Flow uses these accounts/)).not.toBeInTheDocument();
    });

    it('links to the Flow tab with two accounts and the tab registered', async () => {
      const user = userEvent.setup();
      registerFlowTab();
      renderSection({ resolvedAccount: HOME, inherited: true, accounts: [PERSONAL, ACME] });
      expect(await screen.findByText(/Flow uses these accounts for your work/)).toHaveTextContent(
        'Flow uses these accounts for your work. Choose how in Settings → Flow.'
      );
      await user.click(screen.getByRole('button', { name: 'Settings → Flow' }));
      expect(mockSetTab).toHaveBeenCalledWith('flow:fleet');
    });
  });
});
