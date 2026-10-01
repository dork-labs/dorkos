// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostOwnerReplacement, type HostCapabilities } from '../HostOwnerReplacement.js';
import type { HostReplacement } from '../copy.js';
import { mockFetch, refusal, type Call, type Reply } from './harness.js';

// The Owner part of a host community record (specs/community-owner-replacement, "Host page"):
// the form with the fields this host needs, each reason it is disabled, the claim link shown
// once, and Cancel and Send the claim link again on an open request.
const COMMUNITY = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT = '22222222-2222-4222-8222-222222222222';
const LIST = `GET /api/v1/host/communities/${COMMUNITY}/owner-replacements`;
const CREATE = `POST /api/v1/host/communities/${COMMUNITY}/owner-replacements`;
const CANCEL = `POST /api/v1/host/communities/${COMMUNITY}/owner-replacements/${REPLACEMENT}/cancel`;
const RESEND = `POST /api/v1/host/communities/${COMMUNITY}/owner-replacements/${REPLACEMENT}/claim-token`;
const CLAIM_URL = 'http://localhost/owner-replacement#claim-secret';

function replacement(overrides: Partial<HostReplacement> = {}): HostReplacement {
  return {
    replacementId: REPLACEMENT,
    communityId: COMMUNITY,
    state: 'waiting',
    reason: 'owner_unreachable',
    reference: 'CASE-7',
    claimantNamed: false,
    requestedAt: '2026-09-20T10:00:00.000Z',
    requestedBy: { kind: 'person', label: 'Host Operator' },
    notice: { state: 'accepted', resolvedAt: '2026-09-20T10:05:00.000Z', verifiedAddress: true },
    wait: 'standard',
    claimableAfter: '2026-10-04T10:05:00.000Z',
    claimExpiresAt: null,
    claimReissuedAt: null,
    endedAt: null,
    withdrawnBecause: null,
    cooldownUntil: null,
    afterObjection: false,
    afterWithdrawal: false,
    ...overrides,
  };
}

const community = {
  id: COMMUNITY,
  name: 'Acme Ops',
  lifecycle: 'active',
  lifecycleVersion: 4,
  ownerReplacement: null,
};

async function renderSection(
  routes: Record<string, Reply | ((call: Call) => Reply)>,
  options: { capabilities?: HostCapabilities; hasPassword?: boolean; lifecycle?: string } = {}
) {
  const calls = mockFetch(routes);
  const onChanged = vi.fn(async () => {});
  render(
    <HostOwnerReplacement
      community={{ ...community, lifecycle: options.lifecycle ?? 'active' }}
      capabilities={options.capabilities ?? { mail: true, oidc: false }}
      hasPassword={options.hasPassword ?? true}
      onChanged={onChanged}
    />
  );
  fireEvent.click(screen.getByText('Owner'));
  const section = await screen.findByRole('region', { name: 'Owner of Acme Ops' });
  await waitFor(() => expect(within(section).queryByText('Loading requests…')).toBeNull());
  return { calls, section, onChanged };
}

function posts(calls: Call[]) {
  return calls
    .filter((call) => call.method === 'POST')
    .map((call) => ({ url: call.url, body: call.body }));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/host');
  vi.stubGlobal('crypto', { randomUUID: () => 'attempt-key-1' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HostOwnerReplacement', () => {
  it('asks with a reason, reference and password, then shows the claim link once', async () => {
    // Purpose: fails if the request misses a field, sends a single sign-on ID without single
    // sign-on, or the claim link and its sentence are not shown after it.
    const { calls, section, onChanged } = await renderSection({
      [LIST]: { status: 200, body: { replacements: [] } },
      [CREATE]: {
        status: 201,
        body: {
          replacement: replacement({ state: 'notifying' }),
          claimToken: 'claim-secret',
          claimUrl: CLAIM_URL,
          replayed: false,
        },
      },
    });
    expect(within(section).getByText('No change requested.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Replace the owner' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace the owner of Acme Ops?' });
    expect(within(dialog).queryByLabelText('Sign-in ID of the new owner')).toBeNull();
    fireEvent.click(within(dialog).getByLabelText('The owner can’t be reached'));
    fireEvent.change(within(dialog).getByLabelText('Your reference (optional)'), {
      target: { value: 'CASE-7' },
    });
    fireEvent.change(within(dialog).getByLabelText('Your password'), {
      target: { value: 'password1234' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the request' }));
    expect(
      await screen.findByText(
        'Send this link to the new owner. It works only after the waiting period, and only once.'
      )
    ).toBeTruthy();
    expect((screen.getByLabelText('Link for the new owner') as HTMLInputElement).value).toBe(
      CLAIM_URL
    );
    expect(posts(calls)).toEqual([
      {
        url: `/api/v1/host/communities/${COMMUNITY}/owner-replacements`,
        body: {
          lifecycleVersion: 4,
          reason: 'owner_unreachable',
          reference: 'CASE-7',
          claimant: { oidcSubject: null },
          idempotencyKey: 'attempt-key-1',
          password: 'password1234',
        },
      },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('requires the new owner’s sign-in ID when this host has single sign-on', async () => {
    // Purpose: fails if the sign-in ID field is missing, optional, or not sent as the subject.
    const { calls, section } = await renderSection(
      {
        [LIST]: { status: 200, body: { replacements: [] } },
        [CREATE]: {
          status: 201,
          body: {
            replacement: replacement({ state: 'notifying', claimantNamed: true }),
            claimToken: 't',
            claimUrl: CLAIM_URL,
            replayed: false,
          },
        },
      },
      { capabilities: { mail: true, oidc: true } }
    );
    fireEvent.click(within(section).getByRole('button', { name: 'Replace the owner' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Sign-in ID of the new owner') as HTMLInputElement;
    expect(field.required).toBe(true);
    expect(
      within(dialog).getByText(
        'The ID your sign-in service gives this person for this site. Only that account can accept.'
      )
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('Another reason'));
    fireEvent.change(field, { target: { value: 'sub-123' } });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the request' }));
    await screen.findByLabelText('Link for the new owner');
    expect(posts(calls)[0].body).toMatchObject({
      reason: 'other',
      reference: null,
      claimant: { oidcSubject: 'sub-123' },
    });
  });

  it.each<
    [string, { capabilities?: HostCapabilities; hasPassword?: boolean }, HostReplacement[], string]
  >([
    [
      'no mail',
      { capabilities: { mail: false, oidc: false } },
      [],
      'This host can’t send email, so it can’t give the owner notice. Set up mail first.',
    ],
    [
      'a single sign-on operator',
      { hasPassword: false },
      [],
      'Use a host API key with the ownership scope to do this.',
    ],
    [
      'a cooling-off',
      {},
      [
        replacement({
          state: 'objected',
          endedAt: '2026-09-22T09:00:00.000Z',
          cooldownUntil: '2999-12-21T09:00:00.000Z',
        }),
      ],
      'The owner kept ownership on Tuesday, 22 September 2026 (UTC). You can ask again after Saturday, 21 December 2999 (UTC).',
    ],
  ])(
    'disables Replace the owner with %s, and says why',
    async (_label, options, replacements, sentence) => {
      // Purpose: fails if the host can open the form where the server would refuse, or is not
      // told why the button is off.
      const { section } = await renderSection(
        { [LIST]: { status: 200, body: { replacements } } },
        options
      );
      const button = within(section).getByRole('button', {
        name: 'Replace the owner',
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(within(section).getAllByText(sentence).length).toBeGreaterThan(0);
      expect(button.getAttribute('aria-describedby')).toBeTruthy();
    }
  );

  it('offers no new request while one is open, and none outside the lifecycles that allow it', async () => {
    // Purpose: fails if a second request can be started, or one in a suspended community.
    const open = await renderSection({
      [LIST]: { status: 200, body: { replacements: [replacement()] } },
    });
    expect(within(open.section).queryByRole('button', { name: 'Replace the owner' })).toBeNull();
    cleanup();
    const suspended = await renderSection(
      { [LIST]: { status: 200, body: { replacements: [] } } },
      { lifecycle: 'suspended' }
    );
    expect(
      within(suspended.section).queryByRole('button', { name: 'Replace the owner' })
    ).toBeNull();
  });

  it('shows each row in words, and Cancel and Send the claim link again only on open ones', async () => {
    // Purpose: fails if a closed row offers actions or a row's sentence is missing.
    const { section } = await renderSection({
      [LIST]: {
        status: 200,
        body: {
          replacements: [
            replacement(),
            replacement({
              replacementId: '55555555-5555-4555-8555-555555555555',
              state: 'expired',
              endedAt: '2026-08-18T10:05:00.000Z',
              reference: null,
            }),
          ],
        },
      },
    });
    const rows = within(section).getAllByRole('listitem');
    expect(rows[0].textContent).toContain(
      'The owner’s mail server accepted the notice on Sunday, 20 September 2026 (UTC). The owner has until Sunday, 4 October 2026 (UTC).'
    );
    expect(rows[0].textContent).toContain('Your reference: CASE-7.');
    expect(within(rows[0]).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(rows[0]).getByRole('button', { name: 'Send the claim link again' })).toBeTruthy();
    expect(rows[1].textContent).toContain(
      'The new owner didn’t accept in time. Ended on Tuesday, 18 August 2026 (UTC).'
    );
    expect(within(rows[1]).queryByRole('button')).toBeNull();
  });

  it('sends the claim link again only after the confirm says the owner will be told', async () => {
    // Purpose: fails if the reissue skips its confirm, calls another route, or hides the link.
    const { calls, section } = await renderSection({
      [LIST]: { status: 200, body: { replacements: [replacement()] } },
      [RESEND]: {
        status: 200,
        body: { replacementId: REPLACEMENT, claimToken: 'new', claimUrl: CLAIM_URL },
      },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Send the claim link again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send the claim link again?' });
    expect(
      within(dialog).getByText('The owner will be told that the link was sent again.')
    ).toBeTruthy();
    expect(posts(calls)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send it again' }));
    expect(await screen.findByText('The link you sent before no longer works.')).toBeTruthy();
    expect(posts(calls)).toEqual([
      {
        url: `/api/v1/host/communities/${COMMUNITY}/owner-replacements/${REPLACEMENT}/claim-token`,
        body: {},
      },
    ]);
  });

  it('cancels an open request through the cancel route', async () => {
    // Purpose: fails if Cancel calls another route or cancels without the confirm.
    const { calls, section } = await renderSection({
      [LIST]: { status: 200, body: { replacements: [replacement()] } },
      [CANCEL]: {
        status: 200,
        body: replacement({
          state: 'withdrawn',
          withdrawnBecause: 'cancelled',
          endedAt: '2026-09-21T10:00:00.000Z',
        }),
      },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this request?' });
    expect(posts(calls)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByText('Request withdrawn.')).toBeTruthy();
    expect(posts(calls)).toEqual([
      {
        url: `/api/v1/host/communities/${COMMUNITY}/owner-replacements/${REPLACEMENT}/cancel`,
        body: {},
      },
    ]);
  });

  it('shows the server’s sentence when the request is refused, and keeps the form', async () => {
    // Purpose: fails if a refusal (such as the server not sending notices yet) is swallowed.
    const { section } = await renderSection({
      [LIST]: { status: 200, body: { replacements: [] } },
      [CREATE]: refusal(
        409,
        'NOTICE_DELIVERY_UNAVAILABLE',
        "This server can't send the owner's notice yet, so it can't replace an owner."
      ),
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Replace the owner' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('Another reason'));
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the request' }));
    expect(
      await within(dialog).findByText(
        "This server can't send the owner's notice yet, so it can't replace an owner."
      )
    ).toBeTruthy();
    expect(screen.queryByLabelText('Link for the new owner')).toBeNull();
  });
});
