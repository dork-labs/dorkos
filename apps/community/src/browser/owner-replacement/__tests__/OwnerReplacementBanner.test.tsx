// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerReplacementBanner } from '../OwnerReplacementBanner.js';
import { mockFetch } from './harness.js';

// The banners inside a community (specs/community-owner-replacement, "The owner, in the
// community", "Admins", "Every member"): the owner sees only what they can do, the reference as
// quoted text, and keeps ownership in one confirmed step; admins see one sentence; every member
// is told of a completion for a week, dismissible per browser.
const COMMUNITY = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT = '22222222-2222-4222-8222-222222222222';
const READ = `GET /api/v1/communities/${COMMUNITY}/owner-replacement`;
const OBJECTION = `POST /api/v1/communities/${COMMUNITY}/owner-replacement/objection`;
const TRANSFER = 'You can hand the community to someone yourself.';
const DELETE = 'You can delete the community.';
const ADD_PASSWORD = 'To hand it to someone or delete it, add a password to your account first.';
const ADD_PASSWORD_TO_DELETE = 'To delete it, add a password to your account first.';

function ownerNotice(overrides: Record<string, unknown> = {}) {
  return {
    role: 'owner',
    replacementId: REPLACEMENT,
    state: 'waiting',
    reason: 'owner_unreachable',
    requestedAt: '2026-09-20T10:00:00.000Z',
    claimableAfter: '2026-10-04T10:00:00.000Z',
    noticeState: 'accepted',
    reference: 'CASE-2541',
    claimReissuedAt: null,
    options: { keep: true, transfer: true, delete: true, needsPassword: false },
    objectionCooldownDays: 90,
    ...overrides,
  };
}

function renderBanner(lifecycle: string | null = 'active') {
  return render(
    <OwnerReplacementBanner
      communityId={COMMUNITY}
      communityName="Acme Ops"
      lifecycle={lifecycle}
    />
  );
}

/** Wait until the banner has read the notice and rendered what it got. */
async function settled(calls: { url: string }[]) {
  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith('/owner-replacement'))).toBe(true)
  );
  await act(async () => {});
}

async function openDetails() {
  fireEvent.click(await screen.findByRole('button', { name: 'What this means' }));
}

beforeEach(() => {
  window.history.replaceState(null, '', `/c/${COMMUNITY}`);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OwnerReplacementBanner, owner', () => {
  it('says what was asked and the date, and explains it with the reason and every option', async () => {
    // Purpose: fails if the owner's sentence, the reason sentence, or an option allowed by the
    // notice read is missing, or the reissue line shows when nothing was reissued.
    mockFetch({ [READ]: { status: 200, body: { open: ownerNotice(), completed: null } } });
    renderBanner();
    expect(
      await screen.findByText(
        'The host has been asked to make someone else the owner of this community. Unless you keep ownership, that can happen on or after Sunday, 4 October 2026 (UTC).'
      )
    ).toBeTruthy();
    expect(screen.queryByText('The host couldn’t reach you.')).toBeNull();
    await openDetails();
    expect(screen.getByText('The host couldn’t reach you.')).toBeTruthy();
    expect(screen.getByText('The host’s reference: “CASE-2541”')).toBeTruthy();
    expect(screen.getByText(TRANSFER)).toBeTruthy();
    expect(screen.getByText(DELETE)).toBeTruthy();
    expect(screen.queryByText(ADD_PASSWORD)).toBeNull();
    expect(screen.queryByText(/was sent again/u)).toBeNull();
  });

  it.each<[string, string | null, Record<string, boolean>, string[]]>([
    [
      'held, with a password',
      'held',
      { transfer: false, delete: true, needsPassword: false },
      [DELETE],
    ],
    [
      'active, without a password',
      'active',
      { transfer: false, delete: false, needsPassword: true },
      [ADD_PASSWORD],
    ],
    [
      'held, without a password',
      'held',
      { transfer: false, delete: false, needsPassword: true },
      [ADD_PASSWORD_TO_DELETE],
    ],
    [
      'archived, without a password',
      'archived',
      { transfer: false, delete: false, needsPassword: true },
      [ADD_PASSWORD_TO_DELETE],
    ],
    [
      'not loaded yet, without a password',
      null,
      { transfer: false, delete: false, needsPassword: true },
      [ADD_PASSWORD_TO_DELETE],
    ],
  ])('offers only what the owner can do: %s', async (_label, lifecycle, options, shown) => {
    // Purpose: fails if the transfer sentence shows without `transfer`, the delete sentence
    // without `delete`, the add-a-password sentence when a password exists, or a password-less
    // owner of a community that cannot be handed on is told a password would let them.
    mockFetch({
      [READ]: {
        status: 200,
        body: { open: ownerNotice({ options: { keep: true, ...options } }), completed: null },
      },
    });
    renderBanner(lifecycle);
    await openDetails();
    for (const sentence of [TRANSFER, DELETE, ADD_PASSWORD, ADD_PASSWORD_TO_DELETE])
      expect(Boolean(screen.queryByText(sentence))).toBe(shown.includes(sentence));
  });

  it.each([
    ['owner_left_group', 'The host was told you’ve left the group this community belongs to.'],
    ['other', 'The host didn’t give a specific reason.'],
  ])('says the reason %s in words', async (reason, sentence) => {
    // Purpose: fails if a reason code is shown raw or with another reason's sentence.
    mockFetch({
      [READ]: { status: 200, body: { open: ownerNotice({ reason }), completed: null } },
    });
    renderBanner();
    await openDetails();
    expect(screen.getByText(sentence)).toBeTruthy();
  });

  it('shows a reference that looks like an address as quoted text, never a link', async () => {
    // Purpose: fails if the host's reference is ever rendered as an anchor.
    mockFetch({
      [READ]: {
        status: 200,
        body: { open: ownerNotice({ reference: 'www.example.com' }), completed: null },
      },
    });
    const { container } = renderBanner();
    await openDetails();
    const line = screen.getByText('The host’s reference: “www.example.com”');
    expect(line.closest('a')).toBeNull();
    expect(line.querySelector('a')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('adds the reissue line when the link for the new owner was sent again', async () => {
    // Purpose: fails if a reissued claim is not announced to the owner.
    mockFetch({
      [READ]: {
        status: 200,
        body: {
          open: ownerNotice({ claimReissuedAt: '2026-09-25T08:00:00.000Z' }),
          completed: null,
        },
      },
    });
    renderBanner();
    await openDetails();
    expect(
      screen.getByText(
        'The link for the new owner was sent again on Friday, 25 September 2026 (UTC).'
      )
    ).toBeTruthy();
  });

  it('says the least wait while the notice is still going out', async () => {
    // Purpose: fails if the banner shows a blank or invalid date before the wait has a date.
    mockFetch({
      [READ]: {
        status: 200,
        body: {
          open: ownerNotice({ state: 'notifying', claimableAfter: null, noticeState: 'pending' }),
          completed: null,
        },
      },
    });
    renderBanner();
    expect(
      await screen.findByText(
        'The host has been asked to make someone else the owner of this community. Unless you keep ownership, that can happen once a waiting period of at least 7 days has passed.'
      )
    ).toBeTruthy();
  });

  it('keeps ownership after a confirm that says what happens, calling the objection route', async () => {
    // Purpose: fails if Keep ownership objects without the confirm, calls another route, sends
    // anything but the replacement id, or never says it worked.
    let open = true;
    const calls = mockFetch({
      [READ]: () => ({
        status: 200,
        body: { open: open ? ownerNotice({ objectionCooldownDays: 45 }) : null, completed: null },
      }),
      [OBJECTION]: () => {
        open = false;
        return { status: 204 };
      },
    });
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ownership' }));
    const dialog = await screen.findByRole('dialog', { name: 'Keep ownership of Acme Ops?' });
    expect(dialog.textContent).toContain(
      'The host’s request will end. The host can ask again after 45 days, and you’ll be told again.'
    );
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep ownership' }).at(-1)!);
    const kept = await screen.findByText('You kept ownership. The host has been told.');
    // Focus moves to what changed, not back to a button that is gone.
    await waitFor(() => expect(document.activeElement).toBe(kept));
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toEqual([
      {
        url: `/api/v1/communities/${COMMUNITY}/owner-replacement/objection`,
        method: 'POST',
        body: { replacementId: REPLACEMENT },
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'What this means' })).toBeNull()
    );
  });

  it('shows the server’s sentence when keeping ownership is refused', async () => {
    // Purpose: fails if a refusal is swallowed and the owner believes they kept ownership.
    mockFetch({
      [READ]: { status: 200, body: { open: ownerNotice(), completed: null } },
      [OBJECTION]: {
        status: 409,
        body: { code: 'STATE_CONFLICT', message: 'This request has already ended.' },
      },
    });
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep ownership' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep ownership' }).at(-1)!);
    expect(await screen.findByText('This request has already ended.')).toBeTruthy();
    expect(screen.queryByText('You kept ownership. The host has been told.')).toBeNull();
  });
});

describe('OwnerReplacementBanner, admins and members', () => {
  it('tells an admin one sentence with the date, and nothing they could act on', async () => {
    // Purpose: fails if an admin sees the owner's controls, the reason, or the reference.
    mockFetch({
      [READ]: {
        status: 200,
        body: {
          open: {
            role: 'admin',
            replacementId: REPLACEMENT,
            state: 'waiting',
            reason: 'owner_unreachable',
            requestedAt: '2026-09-20T10:00:00.000Z',
            claimableAfter: '2026-10-04T10:00:00.000Z',
            noticeState: 'accepted',
          },
          completed: null,
        },
      },
    });
    renderBanner();
    expect(
      await screen.findByText(
        'The host has been asked to make someone else the owner. The owner has until Sunday, 4 October 2026 (UTC) to respond.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/reach you/u)).toBeNull();
  });

  it('shows nothing to a member while a request is open, or when there is nothing to say', async () => {
    // Purpose: fails if a plain member sees any banner from an empty notice read.
    const calls = mockFetch({ [READ]: { status: 200, body: { open: null, completed: null } } });
    const { container } = renderBanner();
    await settled(calls);
    expect(container.textContent).toBe('');
  });

  it('tells every member of a completion, and remembers a dismissal in this browser', async () => {
    // Purpose: fails if the completion sentence is wrong, the dismissal is not remembered, or
    // it is remembered for a different completion.
    const completed = {
      newOwnerDisplayName: 'Riley Chen',
      completedAt: '2026-09-28T09:00:00.000Z',
    };
    const calls = mockFetch({ [READ]: { status: 200, body: { open: null, completed } } });
    const first = renderBanner();
    const sentence =
      'The host made Riley Chen the owner of this community on Monday, 28 September 2026 (UTC).';
    expect(await screen.findByText(sentence)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(sentence)).toBeNull();
    first.unmount();

    calls.length = 0;
    const again = renderBanner();
    await settled(calls);
    expect(again.container.textContent).toBe('');
    again.unmount();

    mockFetch({
      [READ]: {
        status: 200,
        body: { open: null, completed: { ...completed, completedAt: '2026-09-29T09:00:00.000Z' } },
      },
    });
    renderBanner();
    expect(await screen.findByText(/The host made Riley Chen the owner/u)).toBeTruthy();
  });

  it('still shows and dismisses the completion when the browser refuses storage', async () => {
    // Purpose: fails if blocked storage throws out of render or out of the Dismiss button.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mockFetch({
      [READ]: {
        status: 200,
        body: {
          open: null,
          completed: { newOwnerDisplayName: 'Riley Chen', completedAt: '2026-09-28T09:00:00.000Z' },
        },
      },
    });
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/The host made Riley Chen the owner/u)).toBeNull();
  });
});
