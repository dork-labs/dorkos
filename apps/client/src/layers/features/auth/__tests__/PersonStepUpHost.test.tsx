/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { finishPersonStepUp, requestPersonStepUp } from '@/layers/shared/lib';
import { PersonStepUpHost } from '../ui/PersonStepUpHost';

afterEach(() => {
  act(() => finishPersonStepUp(false));
  cleanup();
  vi.restoreAllMocks();
});

/** Open the step-up, and what it ends with. */
function ask(): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = requestPersonStepUp();
  });
  return answer;
}

describe('PersonStepUpHost', () => {
  it('shows nothing until an action asks', () => {
    render(<PersonStepUpHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms with the owner’s password, then lets the action run', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<PersonStepUpHost />);
    const answer = ask();

    expect(await screen.findByRole('dialog', { name: 'Confirm it’s you' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Password'), 'the-password');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await expect(answer).resolves.toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/person-session$/);
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({ password: 'the-password' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says what went wrong and stays open on a wrong password', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'That password didn’t match. Try again.' }), {
        status: 403,
      })
    );
    render(<PersonStepUpHost />);
    ask();

    await userEvent.type(await screen.findByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That password didn’t match. Try again.'
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('leaves the action refused when the person cancels', async () => {
    render(<PersonStepUpHost />);
    const answer = ask();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await expect(answer).resolves.toBe(false);
  });
});
