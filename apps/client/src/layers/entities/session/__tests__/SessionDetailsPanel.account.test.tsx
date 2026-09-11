// @vitest-environment jsdom
/**
 * The account row in the session details panel (DOR-1970).
 *
 * The panel's own module doc has promised "which runtime and account it belongs
 * to" since it was extracted from `SessionRowFull`, and until DOR-1970 nothing
 * rendered the account half: `AccountMark` only ever reached session ROWS. FB-13
 * asked for it here by name ("maybe also in the session details that appear in
 * the right panel").
 */
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ServerConfig, Session } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { SessionDetailsPanel } from '../ui/SessionDetailsPanel';

afterEach(cleanup);

const ACCOUNTS: Partial<ServerConfig> = {
  claudeCode: {
    resolvedAccount: '/Users/dev/.claude',
    inherited: true,
    accounts: [
      { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
      { id: 'acme-corp', path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: true },
    ],
  },
};

function makeSession(account?: string): Session {
  return {
    id: 'session-1',
    cwd: '/Users/dev/project',
    runtime: 'claude-code',
    // Stated, never defaulted to `Date.now()` — a fixture clock that moves is a
    // fixture that can fail for reasons the test is not about.
    createdAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
    ...(account === undefined ? {} : { account }),
  } as Session;
}

function renderPanel(session: Session, config: Partial<ServerConfig> = ACCOUNTS) {
  const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue(config) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<SessionDetailsPanel session={session} expanded />, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
}

describe('SessionDetailsPanel — the account a session belongs to (DOR-1970)', () => {
  it('names the account the session runs on', async () => {
    renderPanel(makeSession('/Users/dev/.claude2'));

    expect(await screen.findByText('Account')).toBeInTheDocument();
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
  });

  it('names it even when only one account is registered', async () => {
    // Deliberately unlike `AccountMark`, which hides below two accounts. That
    // guard is a LIST argument — an identical badge on every row says nothing —
    // and this panel is opened on purpose rather than scanned.
    renderPanel(makeSession('/Users/dev/.claude'), {
      claudeCode: {
        resolvedAccount: '/Users/dev/.claude',
        inherited: true,
        accounts: [
          { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
        ],
      },
    });

    expect(await screen.findByText('Account')).toBeInTheDocument();
    expect(await screen.findByText('Personal')).toBeInTheDocument();
  });

  it('falls back to the directory for an account the roster does not know', async () => {
    // `defaultAccount` can be set by hand in `~/.dork/config.json` and the
    // server honours it whether or not it is registered, so the row must never
    // render blank.
    renderPanel(makeSession('/Users/dev/.claude-by-hand'));

    expect(await screen.findByText('.claude-by-hand')).toBeInTheDocument();
  });

  it('leaves the row out entirely for a session with no account', async () => {
    // Every runtime with no account concept, and history from before accounts
    // existed. A labelled row with nothing in it is worse than no row.
    renderPanel(makeSession(undefined));

    // Wait for a row that is always present, so the absence below is asserted
    // against a rendered panel rather than against one that has not painted.
    expect(await screen.findByText('Runtime')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Account')).not.toBeInTheDocument());
  });
});
