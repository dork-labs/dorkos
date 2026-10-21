// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pairing } from '../components/Pairing.js';
import { mockFetch } from '../owner-replacement/__tests__/harness.js';

vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({ signIn: { social: vi.fn() }, linkSocial: vi.fn() }),
}));

const CONSENT = 'Let this app manage this space for you';

/** A pending request, as the space sends it to the person reading it. */
function pending(scopes: string[]) {
  return {
    status: 200,
    body: {
      pairingId: 'p_1',
      status: 'pending',
      installName: 'Studio Mac',
      scopes,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The consent line for the `administer` scope (DOR-3005). The space sends `administer` only to an
// owner or admin, and the page asks before it lets the app manage anything.
describe('the consent to let the app manage the space', () => {
  it('is off until ticked, and the approval carries exactly what was chosen', async () => {
    // Purpose: fails if approving without ticking the box ever consents, or ticking it does not.
    for (const tick of [false, true]) {
      const calls = mockFetch({
        'GET /api/v1/pairings/p_1': pending(['read', 'post', 'enroll-agent', 'administer']),
        'POST /api/v1/pairings/approve': { status: 200, body: { approved: true } },
      });
      render(<Pairing search="?pairingId=p_1" />);
      const consent = await screen.findByLabelText(new RegExp(CONSENT, 'u'));
      expect(consent).not.toBeChecked();
      if (tick) fireEvent.click(consent);
      fireEvent.click(screen.getByRole('button', { name: /Approve connection/u }));
      await screen.findByText(/Approved\./u);
      const approve = calls.find((call) => call.url.endsWith('/pairings/approve'));
      expect(approve?.body).toEqual({ pairingId: 'p_1', administer: tick });
      cleanup();
    }
  });

  it('is never shown when the request does not offer it, and is not listed as a permission', async () => {
    // Purpose: fails if a member (whom the space never sends `administer`) sees the consent line,
    // or if `administer` appears as one more thing the connection does.
    mockFetch({ 'GET /api/v1/pairings/p_1': pending(['read', 'post', 'enroll-agent']) });
    render(<Pairing search="?pairingId=p_1" />);
    await screen.findByText('Read channels');
    expect(screen.queryByText(CONSENT)).toBeNull();
    cleanup();
    mockFetch({ 'GET /api/v1/pairings/p_1': pending(['read', 'administer']) });
    render(<Pairing search="?pairingId=p_1" />);
    await screen.findByText(CONSENT);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
  });
});
