/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PERSON_PROOF_STORAGE_KEY } from '@dorkos/shared/person-session';
import { finishPersonStepUp, requestPersonStepUp } from '@/layers/shared/lib';
import { PersonStepUpHost } from '../ui/PersonStepUpHost';

afterEach(() => {
  localStorage.clear();
  act(() => finishPersonStepUp(false));
  cleanup();
  vi.restoreAllMocks();
});

/** Open the step-up, and what it ends with. */
function ask(dismissible = true): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = requestPersonStepUp({ dismissible });
  });
  return answer;
}

/** The server answers the step-up with this, every time. */
function answer(status: number, body: unknown): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

/** Type a password and press Confirm. */
async function confirmWith(password: string): Promise<void> {
  await userEvent.type(await screen.findByLabelText('DorkOS password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
}

describe('PersonStepUpHost', () => {
  it('shows nothing until an action asks', () => {
    render(<PersonStepUpHost />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('confirms with the DorkOS password, then lets the action run', async () => {
    const fetchSpy = answer(200, { ok: true, proof: 'proof-1' });
    render(<PersonStepUpHost />);
    const result = ask();

    expect(await screen.findByRole('alertdialog', { name: 'Confirm it’s you' })).toBeTruthy();
    await confirmWith('the-password');

    await expect(result).resolves.toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toMatch(/\/person-session$/);
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ password: 'the-password' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Kept in this page only, beside the cookie.
    expect(localStorage.getItem(PERSON_PROOF_STORAGE_KEY)).toBe('proof-1');
  });

  it('says so and stays open on a wrong password', async () => {
    answer(403, { error: 'No.', code: 'wrong-password' });
    render(<PersonStepUpHost />);
    ask();

    await confirmWith('wrong');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That’s not your DorkOS password. Try again.'
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    const field = screen.getByLabelText('DorkOS password');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });

  describe('before a person-only action', () => {
    it('cancels with Cancel, leaving the action undone', async () => {
      render(<PersonStepUpHost />);
      const result = ask(true);

      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      await expect(result).resolves.toBe(false);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('cancels with Esc too, even after a wrong password', async () => {
      answer(403, { error: 'No.', code: 'wrong-password' });
      render(<PersonStepUpHost />);
      const result = ask(true);
      await confirmWith('wrong');
      await screen.findByRole('alert');

      await userEvent.keyboard('{Escape}');

      await expect(result).resolves.toBe(false);
    });

    it('gives focus back to what opened it', async () => {
      render(
        <>
          <button type="button">Approve</button>
          <PersonStepUpHost />
        </>
      );
      const opener = screen.getByRole('button', { name: 'Approve' });
      opener.focus();
      ask(true);

      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await act(async () => {});

      expect(document.activeElement).toBe(opener);
    });
  });

  it('acts as a gate: modal, and the app behind it cannot be reached', async () => {
    const app = document.createElement('div');
    app.id = 'root';
    document.body.appendChild(app);
    render(<PersonStepUpHost />);
    ask(false);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(app.inert).toBe(true);
    act(() => finishPersonStepUp(false));
    expect(app.inert).toBe(false);
    app.remove();
  });

  describe('before the first chat', () => {
    it('offers no Cancel, and Esc does nothing', async () => {
      render(<PersonStepUpHost />);
      let settled = false;
      void ask(false).then(() => {
        settled = true;
      });

      await screen.findByLabelText('DorkOS password');
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      await userEvent.keyboard('{Escape}');

      expect(screen.getByRole('alertdialog')).toBeTruthy();
      expect(settled).toBe(false);
    });

    it('counts down after too many tries, with the field off until then', async () => {
      answer(429, { error: 'Too many.', code: 'too-many-attempts', retryAfterSeconds: 32 });
      render(<PersonStepUpHost />);
      ask(false);

      await confirmWith('whatever');

      expect((await screen.findByRole('alert')).textContent).toBe(
        'Too many tries. Try again in 32 sec.'
      );
      expect((screen.getByLabelText('DorkOS password') as HTMLInputElement).disabled).toBe(true);
    });

    it('shows how to set a password when this computer has none, with nothing to type', async () => {
      answer(409, { error: 'No password.', code: 'no-password' });
      render(<PersonStepUpHost />);
      ask(false);

      await confirmWith('whatever');

      expect((await screen.findByRole('alert')).textContent).toBe(
        'This computer has no DorkOS password yet.'
      );
      expect(screen.getByText('dorkos auth reset-password')).toBeTruthy();
      expect(screen.queryByLabelText('DorkOS password')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Forgot it?' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();

      // Once it is set in the terminal, back to the field.
      await userEvent.click(screen.getByRole('button', { name: 'I’ve set one' }));
      expect(screen.getByLabelText('DorkOS password')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('offers Try again when DorkOS cannot be reached', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, proof: 'p' }), { status: 200 })
        );
      render(<PersonStepUpHost />);
      const result = ask(false);

      await confirmWith('pw');
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Can’t reach DorkOS on this computer.'
      );
      // One primary, and no reset: a reset cannot help when DorkOS is unreachable.
      expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Forgot it?' })).toBeNull();
      expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

      await expect(result).resolves.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
