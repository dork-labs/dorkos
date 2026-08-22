/**
 * Smoke test for the Claude accounts showcase states.
 *
 * A broken showcase fails silently: nobody notices until they open the playground
 * looking for the answer to a layout question. Two of these states cannot be
 * reached with the playground's default data at all — a registered roster, and a
 * refused config write — so the helpers that fake them are the thing under test.
 *
 * The accounts panel is no longer a card of its own: it is a section the Claude
 * Code runtime declares, so these render it the way the showcase does, inside
 * that card's opened body. That composition is worth asserting on its own — a
 * declaration that stopped naming `claude-accounts` would leave the card whole
 * and the section gone.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TransportProvider } from '@/layers/shared/model';
import { ClaudeAccountsSection } from '@/layers/features/settings';
import { createPlaygroundTransport } from '../playground-transport';
import {
  LiveRuntimeCard,
  MockedQueryProvider,
  RefusedConfigWriteProvider,
} from '../showcases/settings-showcase-helpers';
import {
  MOCK_SERVER_CONFIG,
  MOCK_SERVER_CONFIG_MULTI_ACCOUNT,
} from '../showcases/settings-mock-data';

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

/**
 * The playground supplies the transport at the app shell (`DevPlayground.tsx`),
 * which is why the showcases themselves only wrap a QueryClient. Mirror that.
 */
function PlaygroundShell({ children }: { children: React.ReactNode }) {
  return <TransportProvider transport={createPlaygroundTransport()}>{children}</TransportProvider>;
}

/** The Claude Code card, opened, with its declared accounts section drawn. */
function AccountsCard() {
  return (
    <LiveRuntimeCard
      type="claude-code"
      expanded
      renderSection={(kind) => (kind === 'claude-accounts' ? <ClaudeAccountsSection /> : null)}
    />
  );
}

describe('Claude accounts showcase states', () => {
  afterEach(cleanup);

  it('renders the section inside the card that declares it', () => {
    render(
      <PlaygroundShell>
        <MockedQueryProvider>
          <AccountsCard />
        </MockedQueryProvider>
      </PlaygroundShell>
    );

    const section = screen.getByTestId('runtime-card-section-claude-accounts-claude-code');
    expect(within(section).getByRole('combobox', { name: 'Default account' })).toBeVisible();
  });

  it('shows the default install with nothing registered', () => {
    render(
      <PlaygroundShell>
        <MockedQueryProvider>
          <AccountsCard />
        </MockedQueryProvider>
      </PlaygroundShell>
    );

    expect(screen.getByRole('combobox', { name: 'Default account' })).toHaveTextContent(
      `Default (${MOCK_SERVER_CONFIG.claudeCode!.resolvedAccount.replace('/Users/dev', '~')})`
    );
    expect(screen.queryByTestId('claude-account-row')).not.toBeInTheDocument();
  });

  it('shows the populated roster, including a folder that is not an account yet', () => {
    render(
      <PlaygroundShell>
        <MockedQueryProvider config={MOCK_SERVER_CONFIG_MULTI_ACCOUNT}>
          <AccountsCard />
        </MockedQueryProvider>
      </PlaygroundShell>
    );

    expect(screen.getAllByTestId('claude-account-row')).toHaveLength(4);
    expect(screen.getByText('in use')).toBeInTheDocument();
    // The unlabeled account falls back to its folder name.
    expect(screen.getByText('.claude3')).toBeInTheDocument();
    expect(screen.getByTestId('claude-account-not-ready')).toBeInTheDocument();
  });

  it('really refuses the write in the refused-write state', async () => {
    const user = userEvent.setup();
    render(
      <RefusedConfigWriteProvider>
        <MockedQueryProvider config={MOCK_SERVER_CONFIG_MULTI_ACCOUNT}>
          <AccountsCard />
        </MockedQueryProvider>
      </RefusedConfigWriteProvider>
    );

    await user.click(screen.getByRole('combobox', { name: 'Default account' }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'Personal' }));

    // Red if the transport override stops reaching the section — the state would
    // then look identical to a successful write.
    await waitFor(() =>
      expect(screen.getByTestId('claude-account-error')).toHaveTextContent(
        'Only a person can change those settings'
      )
    );
  });
});
