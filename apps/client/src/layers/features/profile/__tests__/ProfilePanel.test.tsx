/**
 * @vitest-environment jsdom
 *
 * Settings › Profile.
 *
 * The load-bearing block is the handle one. `PATCH /api/rooms/authors/:id/handle`
 * refuses in three typed ways and they are three different things for the
 * person to do about it — somebody else has it, it is spoken for, or it is not
 * a spellable handle — so a form that answered "couldn't save that" three times
 * would be throwing the answer away. These tests assert the three messages are
 * distinct from each other, which is a claim a single generic string cannot pass.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ProfilePanel } from '../ui/ProfilePanel';

const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;

/** A refusal shaped exactly as `http-client.ts` throws one. */
function refusal(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function renderPanel(
  member: TeamMember = SELF,
  transportOverrides: Partial<Transport> = {}
): Transport {
  const transport = createMockTransport(transportOverrides);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ProfilePanel member={member} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

/** Type a new handle and press its Save. */
async function saveHandle(next: string) {
  const field = screen.getByLabelText('Handle');
  await userEvent.clear(field);
  await userEvent.type(field, next);
  // Two Saves on screen; the handle's is the one inside the handle field's row.
  await userEvent.click(saveButtonBeside(field));
}

/** The Save button sitting beside a given input. */
function saveButtonBeside(field: HTMLElement): HTMLElement {
  const save = field.parentElement?.querySelector('button');
  if (!save) throw new Error('no Save beside that field');
  return save as HTMLElement;
}

afterEach(cleanup);

describe('ProfilePanel — the handle’s three refusals', () => {
  /** Drive one refusal through the form and return the sentence it showed. */
  async function messageFor(code: string, serverSays: string): Promise<string> {
    renderPanel(SELF, {
      setAuthorHandle: vi.fn().mockRejectedValue(refusal(code, serverSays)),
    } as Partial<Transport>);
    await saveHandle('taken');
    const note = await screen.findByRole('alert');
    return note.textContent ?? '';
  }

  it('says three different things for HANDLE_TAKEN, HANDLE_RESERVED and INVALID_HANDLE', async () => {
    const taken = await messageFor('HANDLE_TAKEN', "@taken is already somebody else's handle.");
    cleanup();
    const reserved = await messageFor('HANDLE_RESERVED', '@taken is reserved.');
    cleanup();
    const invalid = await messageFor('INVALID_HANDLE', 'A handle is all lowercase.');

    expect(new Set([taken, reserved, invalid]).size).toBe(3);
    // And each one has to say something about ITS refusal, not just differ.
    expect(taken).toMatch(/someone else/i);
    expect(reserved).toMatch(/spoken for/i);
    // The server knows WHICH of five grammar rules broke; the form does not, so
    // it passes that sentence through rather than inventing a vaguer one.
    expect(invalid).toContain('A handle is all lowercase.');
  });

  it('never falls back to one generic sentence when the code is known', async () => {
    const taken = await messageFor('HANDLE_TAKEN', '');
    expect(taken).not.toMatch(/could not be saved/i);
  });
});

describe('ProfilePanel — the photo', () => {
  /** A real 1×1 PNG, so the picker has actual bytes to hand over. */
  function pngFile() {
    return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'me.png', { type: 'image/png' });
  }

  it('uploads the file the person picked', async () => {
    const uploadProfileAvatar = vi.fn().mockResolvedValue({ imageUrl: '/api/profile/avatar/x' });
    renderPanel(SELF, { uploadProfileAvatar } as Partial<Transport>);

    await userEvent.upload(screen.getByTestId('profile-photo-input'), pngFile());

    await waitFor(() => expect(uploadProfileAvatar).toHaveBeenCalledTimes(1));
    expect(uploadProfileAvatar.mock.calls[0][1]).toBe('me.png');
  });

  it('maps each upload refusal to what to do about it', async () => {
    const cases: [string, RegExp][] = [
      ['AVATAR_TOO_LARGE', /over 2 MB/i],
      ['AVATAR_TYPE_UNSUPPORTED', /PNG, JPEG or WebP/i],
      ['AVATAR_MISSING', /came through/i],
      ['OPERATOR_ONLY', /only the person at the keyboard/i],
    ];
    for (const [code, expected] of cases) {
      renderPanel(SELF, {
        uploadProfileAvatar: vi.fn().mockRejectedValue(refusal(code, 'server wording')),
      } as Partial<Transport>);
      await userEvent.upload(screen.getByTestId('profile-photo-input'), pngFile());
      expect((await screen.findByRole('alert')).textContent).toMatch(expected);
      cleanup();
    }
  });

  it('offers Remove only when there is a photo to remove, and clears it', async () => {
    renderPanel(SELF);
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload a photo' })).toBeInTheDocument();
    cleanup();

    const deleteProfileAvatar = vi.fn().mockResolvedValue(undefined);
    const withPhoto: TeamMember = { ...SELF, imageUrl: '/api/profile/avatar/me?v=1' };
    renderPanel(withPhoto, { deleteProfileAvatar } as Partial<Transport>);

    expect(screen.getByRole('button', { name: 'Change photo' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleteProfileAvatar).toHaveBeenCalledTimes(1));
  });
});

describe('ProfilePanel — name and email', () => {
  it('saves a changed name and refuses to offer Save for an unchanged one', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ displayName: 'Dorian C' });
    renderPanel(SELF, { updateProfile } as Partial<Transport>);

    const field = screen.getByLabelText('Display name');
    expect(saveButtonBeside(field)).toBeDisabled();

    await userEvent.type(field, ' C');
    await userEvent.click(saveButtonBeside(field));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith('Dorian C'));
  });

  it('offers "You" as a placeholder rather than seeding it as a chosen name', () => {
    // `You` is the roster's fallback when nothing knows this person's name.
    // Seeding the field with it would present a guess as a decision and then
    // let them save it — and the Save button would be live for a name they
    // never typed.
    renderPanel({ ...SELF, displayName: 'You' });
    const field = screen.getByLabelText('Display name');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'You');
    expect(saveButtonBeside(field)).toBeDisabled();
  });

  it('says so after a save, and stops saying so once you type again', async () => {
    renderPanel(SELF, {
      updateProfile: vi.fn().mockResolvedValue({ displayName: 'Dorian C' }),
    } as Partial<Transport>);

    const field = screen.getByLabelText('Display name');
    await userEvent.type(field, ' C');
    await userEvent.click(saveButtonBeside(field));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');

    // TanStack keeps `isSuccess` true forever, so an unconditional note would
    // sit under a field the person has since edited and claim their unsaved
    // draft was stored.
    await userEvent.type(field, 'x');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  describe('a name an agent suggested (DOR-1022)', () => {
    /** The operator's row, with the provenance the payload would carry. */
    function withSuggestion(nameSuggestedBy: string | null): TeamMember {
      return { ...SELF, person: { ...SELF.person!, nameSuggestedBy } };
    }

    it('says where the name in the field came from', () => {
      renderPanel(withSuggestion('DorkBot'));
      expect(screen.getByText(/Suggested by DorkBot/)).toBeInTheDocument();
    });

    it('lets an UNCHANGED name be saved, because that is how the note is cleared', async () => {
      // The one place the disabled-Save rule bends, and it has to: somebody who
      // likes the name DorkBot picked has no other way to say "that one is
      // mine". Without this the note is permanent for exactly the people it
      // least needs to bother.
      const updateProfile = vi.fn().mockResolvedValue({ displayName: 'Dorian' });
      renderPanel(withSuggestion('DorkBot'), { updateProfile } as Partial<Transport>);

      const field = screen.getByLabelText('Display name');
      expect(field).toHaveValue('Dorian');
      expect(saveButtonBeside(field)).toBeEnabled();

      await userEvent.click(saveButtonBeside(field));
      await waitFor(() => expect(updateProfile).toHaveBeenCalledWith('Dorian'));
    });

    it('still refuses to save an emptied field', () => {
      // The bend above is about an unchanged name, not about no name: the server
      // and the request schema both refuse an empty one.
      renderPanel({ ...withSuggestion('DorkBot'), displayName: 'You' });
      const field = screen.getByLabelText('Display name');
      expect(field).toHaveValue('');
      expect(saveButtonBeside(field)).toBeDisabled();
    });

    it('says nothing extra about a name nobody flagged', () => {
      renderPanel(SELF);
      expect(screen.getByText('What DorkOS calls you.')).toBeInTheDocument();
      expect(screen.queryByText(/suggested by/i)).toBeNull();
    });
  });

  it('shows the account email and never lets it be edited here', () => {
    renderPanel(SELF);
    const email = screen.getByLabelText('Email');
    expect(email).toHaveValue(SELF.person!.email!);
    expect(email).toHaveAttribute('readonly');
  });

  it('says where to turn login on when this machine has no account', () => {
    const noAccount: TeamMember = { ...SELF, person: { role: null, lastSeenAt: null } };
    renderPanel(noAccount);
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByText(/no login on this machine/i)).toBeInTheDocument();
  });
});
