/**
 * @vitest-environment jsdom
 */
/**
 * The auth-error card's DorkOS credits lead (spec `dorkos-account-by-default`
 * §3): first only for a runtime with no sign-in at all that credits reach,
 * with the runtime's own sign-in right under it; never for a sign-in that
 * expired, which leads with signing in again.
 *
 * The offer itself is the app shell's (`widgets/credits-offer`), so a stand-in
 * renders it here: what this card owns is WHETHER it leads and what choosing
 * credits does for the failed turn.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { createMockTransport } from '@dorkos/test-utils';
import {
  CreditsOfferProvider,
  TransportProvider,
  useAppStore,
  type CreditsOfferSlot,
} from '@/layers/shared/model';
import { ErrorMessageBlock } from '../ErrorMessageBlock';

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: vi.fn() }),
}));

vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({
    sessions: [{ id: SESSION_ID, runtime: 'claude-code' } as Session],
    isLoading: false,
  }),
}));

const SESSION_ID = 'session-1';
const CLI: DependencyCheck = { name: 'Claude Code CLI', description: 'cli', status: 'satisfied' };

/** A stand-in for the app shell's offer: one button that makes the choice. */
const stubOffer: CreditsOfferSlot = ({ onChoose, note, confirmAfterLink }) => (
  <div>
    <button type="button" onClick={() => void onChoose?.()}>
      Stand-in credits offer
    </button>
    <p>{note}</p>
    <p data-testid="after-link">{confirmAfterLink?.prompt}</p>
  </div>
);

function renderCard(
  signIn: 'none' | 'expired',
  options: { remote?: boolean; saidNo?: boolean } = {}
) {
  const transport = createMockTransport({
    getConfig: vi
      .fn()
      .mockResolvedValue({ version: '1.0.0', isLocalCaller: !options.remote, port: 4242 }),
  });
  vi.mocked(transport.checkRequirements).mockResolvedValue({
    runtimes: {
      'claude-code': {
        dependencies: [
          CLI,
          {
            name: 'Claude Code authentication',
            description: 'auth',
            status: 'missing',
            ...(signIn === 'expired' ? { expiresAt: '2026-09-01T00:00:00.000Z' } : {}),
          },
        ],
      },
    },
  });
  vi.mocked(transport.getCloudCredits).mockResolvedValue({
    enabled: false,
    killed: false,
    linked: false,
    ready: false,
    runtimes: {
      'claude-code': 'wired',
      codex: 'follow-up',
      opencode: 'follow-up',
      doe: 'follow-up',
    },
    ...(options.saidNo
      ? {
          defaults: {
            'claude-code': { runsOn: 'own-sign-in' as const, chosenBy: 'user' as const },
          },
        }
      : {}),
  });
  const onRetry = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CreditsOfferProvider slot={stubOffer}>
          <ErrorMessageBlock
            message="401"
            category="auth_error"
            sessionId={SESSION_ID}
            onRetry={onRetry}
          />
        </CreditsOfferProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onRetry, queryClient };
}

describe('the auth-error card and DorkOS credits', () => {
  afterEach(() => {
    cleanup();
    useAppStore.getState().setRetryAccount(null);
  });

  it('leads with credits for a runtime with no sign-in, its own sign-in right under it', async () => {
    renderCard('none');
    const offer = await screen.findByRole('button', { name: 'Stand-in credits offer' });
    const signIn = screen.getByTestId('auth-error-signin-button');
    expect(offer.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('keep-it-local-note')).toBeInTheDocument();
  });

  it('choosing credits puts the runtime on them and sends the turn again on credits', async () => {
    const { transport, onRetry } = renderCard('none');
    fireEvent.click(await screen.findByRole('button', { name: 'Stand-in credits offer' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(transport.setCloudCreditsDefault).toHaveBeenCalledWith('claude-code', true);
    expect(useAppStore.getState().retryAccount).toEqual({
      id: CREDITS_ACCOUNT_ID,
      sessionId: SESSION_ID,
    });
  });

  it('leads with signing in again when the sign-in expired, and offers no credits', async () => {
    const { queryClient } = renderCard('expired');
    await waitFor(() => {
      expect(queryClient.getQueryState(['requirements'])?.status).toBe('success');
      expect(queryClient.getQueryState(['cloud', 'plan-aware', 'credits'])?.status).toBe('success');
    });
    expect(await screen.findByTestId('auth-error-signin-button')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Stand-in credits offer' })
    ).not.toBeInTheDocument();
  });

  it('says plainly what choosing credits changes, and asks before sending after a link', async () => {
    renderCard('none');
    expect(
      await screen.findByText(
        'This makes new Claude Code work on this computer run on your DorkOS credits.'
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('after-link')).toHaveTextContent(
      'Linked. Send again on DorkOS credits?'
    );
  });

  it('offers credits on a phone too, with the guidance under them', async () => {
    renderCard('none', { remote: true });
    expect(
      await screen.findByRole('button', { name: 'Stand-in credits offer' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('auth-error-remote-guidance')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-error-signin-button')).not.toBeInTheDocument();
  });

  it('keeps a person’s "no": signing in leads, credits are a row under it', async () => {
    renderCard('none', { saidNo: true });
    const offer = await screen.findByRole('button', { name: 'Stand-in credits offer' });
    const signIn = screen.getByTestId('auth-error-signin-button');
    expect(signIn.compareDocumentPosition(offer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('keep-it-local-note')).not.toBeInTheDocument();
  });
});
