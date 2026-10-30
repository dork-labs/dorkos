/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HeldStepUpView } from '@dorkos/shared/step-up';
import {
  finishActionStepUp,
  getActionStepUpShowing,
  requestActionStepUp,
  type ActionStepUpOutcome,
} from '@/layers/shared/lib';
import { ActionStepUpHost } from '../ui/ActionStepUpHost';

const VIEW: HeldStepUpView = {
  heldActionId: 'held-1',
  kind: 'mcp-server.allow-global',
  reason:
    'Confirm it’s you to add github (`@modelcontextprotocol/server-github`) for all your agents.',
  notes: ['Not pinned to a version. What runs can change later.'],
  expiresAt: '2026-10-30T12:02:00.000Z',
  methods: ['password'],
  triesLeft: 5,
};

afterEach(() => {
  act(() => {
    while (getActionStepUpShowing() !== null) finishActionStepUp({ kind: 'not-confirmed' });
  });
  cleanup();
  vi.restoreAllMocks();
});

/** Open the sheet for one held action, and what it ends with. */
function ask(id = 'held-1'): Promise<ActionStepUpOutcome> {
  let outcome!: Promise<ActionStepUpOutcome>;
  act(() => {
    outcome = requestActionStepUp(id);
  });
  return outcome;
}

type Route = (method: string, url: string, body: unknown) => [number, unknown];

/** The server, answering each step-up call by method and path. */
function server(route: Route): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const [status, answer] = route(method, String(input), body);
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(answer), { status });
  });
}

/** A server that shows `view` and answers a password confirm with `confirm`. */
function heldWith(view: HeldStepUpView, confirm: [number, unknown]) {
  return server((method, url) => {
    if (method === 'GET') return [200, view];
    if (method === 'DELETE') return [204, null];
    if (url.endsWith('/password')) return confirm;
    return [404, { code: 'expired', error: 'That took too long. Nothing changed.' }];
  });
}

async function confirmWith(password: string): Promise<void> {
  // The field stays disabled until the server's held action has loaded.
  await screen.findByText(VIEW.reason);
  await userEvent.type(await screen.findByLabelText('DorkOS password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
}

describe('ActionStepUpHost', () => {
  it('shows nothing until an action is held', () => {
    render(<ActionStepUpHost />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the server’s own sentence about what will run', async () => {
    heldWith(VIEW, [200, { ok: true, status: 201, result: {} }]);
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByText(VIEW.reason)).toBeTruthy();
    expect(screen.getByText(VIEW.notes[0]!)).toBeTruthy();
  });

  it('confirms with the password and answers with the action’s own result', async () => {
    const fetchSpy = heldWith(VIEW, [200, { ok: true, status: 201, result: { added: 'github' } }]);
    render(<ActionStepUpHost />);
    const outcome = ask();
    await confirmWith('the-password');
    await expect(outcome).resolves.toEqual({
      kind: 'confirmed',
      status: 201,
      result: { added: 'github' },
    });
    const confirm = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/password'))!;
    // Only the held action's id and the password: never the action itself.
    expect(String(confirm[0])).toMatch(/\/step-up\/held-1\/password$/);
    expect(JSON.parse(String((confirm[1] as RequestInit).body))).toEqual({
      password: 'the-password',
    });
  });

  it('cancels: nothing ran, and the server is told to drop it', async () => {
    const fetchSpy = heldWith(VIEW, [200, { ok: true, status: 200, result: {} }]);
    render(<ActionStepUpHost />);
    const outcome = ask();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(outcome).resolves.toEqual({ kind: 'not-confirmed' });
    expect(fetchSpy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(
      true
    );
  });

  it('says how many tries are left after a wrong password, and stays open', async () => {
    heldWith(VIEW, [403, { code: 'wrong-password', error: 'Wrong.', triesLeft: 4 }]);
    render(<ActionStepUpHost />);
    void ask();
    await confirmWith('nope');
    expect(await screen.findByText('That’s not your DorkOS password. 4 tries left.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('ends on the last wrong password: nothing changed', async () => {
    heldWith(VIEW, [403, { code: 'too-many-tries', error: 'x' }]);
    render(<ActionStepUpHost />);
    void ask();
    await confirmWith('nope');
    expect(await screen.findByText('Too many wrong passwords. Nothing changed.')).toBeTruthy();
    expect(screen.queryByLabelText('DorkOS password')).toBeNull();
  });

  it('offers to ask again once it expired', async () => {
    heldWith(VIEW, [404, { code: 'expired', error: 'x' }]);
    render(<ActionStepUpHost />);
    const outcome = ask();
    await confirmWith('the-password');
    expect(await screen.findByText('That took too long. Nothing changed.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await expect(outcome).resolves.toEqual({ kind: 'ask-again' });
  });

  it('never offers a password field over plain http from another device', async () => {
    heldWith({ ...VIEW, methods: [], passwordUnavailable: 'insecure-connection' }, [
      200,
      { ok: true, status: 200, result: {} },
    ]);
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByText('Confirm this on the computer running DorkOS.')).toBeTruthy();
    expect(screen.queryByLabelText('DorkOS password')).toBeNull();
  });

  it('says how to set a password when the owner has none', async () => {
    heldWith({ ...VIEW, methods: [], passwordUnavailable: 'no-password' }, [
      200,
      { ok: true, status: 200, result: {} },
    ]);
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByText('dorkos auth reset-password')).toBeTruthy();
    expect(screen.queryByLabelText('DorkOS password')).toBeNull();
  });

  // Security's Must 3: in the Mac app the password is never typed into this page.
  describe('in the Mac app', () => {
    afterEach(() => {
      delete (window as { electronAPI?: unknown }).electronAPI;
    });

    it('hands the confirm to the shell’s own window and shows no password field', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const confirmStepUp = vi.fn(async () => ({
        kind: 'confirmed' as const,
        status: 201,
        result: { added: 'github' },
      }));
      (window as { electronAPI?: unknown }).electronAPI = { confirmStepUp };
      render(<ActionStepUpHost />);
      const outcome = ask();
      await expect(outcome).resolves.toEqual({
        kind: 'confirmed',
        status: 201,
        result: { added: 'github' },
      });
      expect(confirmStepUp).toHaveBeenCalledExactlyOnceWith('held-1');
      // The page itself never reads the held action or posts anything.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('says where to confirm while the shell’s window is open', async () => {
      (window as { electronAPI?: unknown }).electronAPI = {
        confirmStepUp: () => new Promise(() => undefined),
      };
      render(<ActionStepUpHost />);
      void ask();
      expect(await screen.findByText('Confirm in the window that just opened.')).toBeTruthy();
      expect(screen.queryByLabelText('DorkOS password')).toBeNull();
    });

    it('never falls back to a password field on an older app', async () => {
      (window as { electronAPI?: unknown }).electronAPI = {};
      render(<ActionStepUpHost />);
      const outcome = ask();
      expect(await screen.findByText('Update the DorkOS app to confirm this.')).toBeTruthy();
      expect(screen.queryByLabelText('DorkOS password')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      await expect(outcome).resolves.toEqual({ kind: 'not-confirmed' });
    });
  });

  it('turns a too-short password into change-and-confirm, in place', async () => {
    const fetchSpy = server((method, url) => {
      if (method === 'GET') return [200, VIEW];
      if (url.endsWith('/password'))
        return [409, { code: 'password-too-short', error: 'x', minLength: 8 }];
      if (url.endsWith('/change-password')) return [200, { ok: true, status: 201, result: {} }];
      return [204, null];
    });
    render(<ActionStepUpHost />);
    const outcome = ask();
    await confirmWith('short');
    await userEvent.type(await screen.findByLabelText('New password'), 'a much longer one');
    await userEvent.click(screen.getByRole('button', { name: 'Change and confirm' }));
    await expect(outcome).resolves.toMatchObject({ kind: 'confirmed', status: 201 });
    const change = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/change-password'))!;
    expect(JSON.parse(String((change[1] as RequestInit).body))).toEqual({
      currentPassword: 'short',
      newPassword: 'a much longer one',
    });
  });
});
