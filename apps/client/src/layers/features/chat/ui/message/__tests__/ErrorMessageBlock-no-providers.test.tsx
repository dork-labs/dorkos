/**
 * @vitest-environment jsdom
 */
/**
 * An `auth_error` block with no session must render with NO data providers.
 *
 * This lives in its own file because the main suite mocks `useSessions` to
 * control the session row — and a mocked data hook needs no QueryClient, so the
 * same assertion made over there would pass whether or not the guard exists
 * (it was written that way first, and the mutation proved it vacuous). Here the
 * session layer is deliberately REAL: if the session read ever moves above the
 * `sessionId` guard in `AuthErrorActions`, `useQueryClient` throws on mount and
 * this file goes red.
 *
 * The case is not hypothetical. `ErrorMessageBlock` is rendered bare — no
 * QueryClientProvider, no TransportProvider — by callers that only want the
 * error chrome, and DOR-1649's hydrated API-error test mounts exactly that
 * shape.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ErrorMessageBlock } from '../ErrorMessageBlock';

// Only the router-backed deep link is stubbed — the data layer stays real,
// which is the whole point of this file.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSettingsDeepLink: () => ({ open: openSettings }),
}));

afterEach(() => {
  cleanup();
  openSettings.mockClear();
});

describe('ErrorMessageBlock auth_error without a session', () => {
  it('renders and deep-links with no QueryClient and no Transport in scope', () => {
    render(<ErrorMessageBlock message="401 revoked" category="auth_error" />);

    expect(screen.getByText('Sign in to your agent again')).toBeInTheDocument();
    // No session means no honest way to know what to sign into, so the only
    // action is the route to Settings.
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /fix sign-in/i }));
    expect(openSettings).toHaveBeenCalledWith('runtimes');
  });

  it('renders a non-auth error block with no providers either', () => {
    // The plain path has never needed providers; pinned so the auth work above
    // cannot quietly drag a data dependency into the shared chrome.
    render(<ErrorMessageBlock message="boom" category="execution_error" details="stack" />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
  });
});
