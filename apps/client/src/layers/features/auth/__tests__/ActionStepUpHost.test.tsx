/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HeldStepUpView } from '@dorkos/shared/step-up';
import {
  finishActionStepUp,
  getActionStepUpShowing,
  noteStepUpReload,
  openActionStepUpFromLink,
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

/** What the Mac app's sheet says while the shell's own window asks (designer, DOR-4909). */
const DESKTOP_SHEET_LINE = 'Finish in the “Confirm it’s you” window. Closing it changes nothing.';

afterEach(() => {
  act(() => {
    for (let id = getActionStepUpShowing(); id !== null; id = getActionStepUpShowing()) {
      finishActionStepUp(id, { kind: 'not-confirmed' });
    }
  });
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  document.body.innerHTML = '';
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
  await userEvent.click(screen.getByRole('button', { name: /^Confirm( setting)?$/ }));
}

describe('ActionStepUpHost', () => {
  it.each([
    ['api-key.create', 'Create key'],
    ['api-key.update', 'Save key'],
    ['devices.sign-out-one', 'Sign it out'],
    ['devices.sign-out-others', 'Sign out others'],
    ['devices.sign-out-all', 'Sign out everywhere'],
    ['extensions.trust-source', 'Trust source'],
    ['session-relay.link', 'Create link'],
    ['relay-passkey.enrol', 'Add passkey'],
  ] as const)('names the confirmation for %s', async (kind, label) => {
    heldWith({ ...VIEW, kind }, [200, { ok: true, status: 200, result: {} }]);
    render(<ActionStepUpHost />);
    const outcome = ask();
    const button = await screen.findByRole('button', { name: label });
    await userEvent.type(await screen.findByLabelText('DorkOS password'), 'made-up-password');
    await userEvent.click(button);
    await expect(outcome).resolves.toEqual({ kind: 'confirmed', status: 200, result: {} });
  });
  it('shows nothing until an action is held', () => {
    render(<ActionStepUpHost />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the server request code with a read-aloud label', async () => {
    heldWith({ ...VIEW, requestCode: 'K7MR-4XQ9-HT3W' }, [
      200,
      { ok: true, status: 200, result: {} },
    ]);
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByText('K7MR-4XQ9-HT3W')).toBeVisible();
    expect(screen.getByRole('group', { name: 'Request K 7 M R, 4 X Q 9, H T 3 W' })).toBeVisible();
  });

  const CODE_NOTE = 'Check that the request you came from shows the same code.';

  it.each([
    ['with no notes of its own', []],
    ['with notes of its own', ['Asked by Porter.']],
  ])('never shows a request code without its note, %s', async (_label, notes) => {
    heldWith({ ...VIEW, notes, requestCode: 'K7MR-4XQ9-HT3W' }, [
      200,
      { ok: true, status: 200, result: {} },
    ]);
    render(<ActionStepUpHost />);
    void ask();
    await screen.findByText('K7MR-4XQ9-HT3W');
    const note = screen.getByText(CODE_NOTE);
    expect(note).toBeVisible();
    expect(screen.getAllByText(CODE_NOTE)).toHaveLength(1);
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      expect.stringContaining(CODE_NOTE)
    );
  });

  it('shows no code note when the server sends no code', async () => {
    heldWith(VIEW, [200, { ok: true, status: 200, result: {} }]);
    render(<ActionStepUpHost />);
    void ask();
    await screen.findByText(VIEW.reason);
    expect(screen.queryByText(CODE_NOTE)).toBeNull();
  });

  it('re-holds after a confirmation for a different request', async () => {
    heldWith(VIEW, [
      409,
      {
        code: 'different-request',
        error: 'That confirmation was for a different request. Confirm this one.',
      },
    ]);
    render(<ActionStepUpHost />);
    const outcome = ask();
    await confirmWith('the-password');
    await expect(outcome).resolves.toEqual({ kind: 'ask-again', reason: 'different-request' });
  });

  it('shows the server’s own sentence about what will run', async () => {
    heldWith(VIEW, [200, { ok: true, status: 201, result: {} }]);
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByText(VIEW.reason)).toBeTruthy();
    expect(screen.getByText(VIEW.notes[0]!)).toBeTruthy();
  });

  it('shows a warning in warning ink, in its place among the notes, and the rest quietly', async () => {
    const warning = 'Made-up line to look at twice.';
    const last = 'All your agents get it.';
    heldWith({ ...VIEW, notes: [VIEW.notes[0]!, warning, last], warnings: [warning] }, [
      200,
      { ok: true, status: 201, result: {} },
    ]);
    render(<ActionStepUpHost />);
    void ask();
    const line = await screen.findByText(warning);
    expect(line).toHaveClass('text-status-warning-fg');
    expect(screen.getByText(VIEW.notes[0]!)).toHaveClass('text-muted-foreground');
    expect(screen.getByText(last)).toHaveClass('text-muted-foreground');
    expect(line.nextElementSibling).toBe(screen.getByText(last));
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

  it('waits for the password check before it can be cancelled', async () => {
    let answer!: (value: [number, unknown]) => void;
    const pendingConfirm = new Promise<[number, unknown]>((resolve) => (answer = resolve));
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === 'GET') return new Response(JSON.stringify(VIEW), { status: 200 });
      const [status, body] = await pendingConfirm;
      return new Response(JSON.stringify(body), { status });
    });
    render(<ActionStepUpHost />);
    const outcome = ask();
    await confirmWith('the-password');
    const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancelButton).toHaveProperty('disabled', true);
    // Esc while the check is in flight closes nothing and drops nothing.
    await userEvent.keyboard('{Escape}');
    expect(getActionStepUpShowing()).toBe('held-1');
    expect(calls).not.toContain('DELETE');
    await act(async () => answer([200, { ok: true, status: 201, result: { added: 'github' } }]));
    await expect(outcome).resolves.toEqual({
      kind: 'confirmed',
      status: 201,
      result: { added: 'github' },
    });
  });

  it('says how many tries are left after a wrong password, and stays open', async () => {
    heldWith(VIEW, [403, { code: 'wrong-password', error: 'Wrong.', triesLeft: 4 }]);
    render(<ActionStepUpHost />);
    void ask();
    await confirmWith('nope');
    expect(await screen.findByText('That’s not your DorkOS password.')).toBeTruthy();
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

  it('asks for the action again once it expired, with no extra step', async () => {
    heldWith(VIEW, [404, { code: 'expired', error: 'x' }]);
    render(<ActionStepUpHost />);
    const outcome = ask();
    await confirmWith('the-password');
    await expect(outcome).resolves.toEqual({ kind: 'ask-again' });
  });

  describe('opened from a link a page outside the app gave', () => {
    const LINKED = '01M7M696Q8GA7H8MQ7WVRZ1K4P';

    it('opens the sheet for that held action once, and takes the id out of the address', async () => {
      heldWith({ ...VIEW, heldActionId: LINKED, requestCode: 'K7MR-4XQ9-HT3W' }, [
        200,
        { ok: true, status: 200, result: {} },
      ]);
      const replaceState = vi.fn();
      render(<ActionStepUpHost />);
      act(() => {
        openActionStepUpFromLink(
          { href: `https://dorkos.example/?confirm=${LINKED}#top` },
          { replaceState, state: null }
        );
      });
      expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/#top');
      expect(getActionStepUpShowing()).toBe(LINKED);
      // The same code the page that sent the person here shows.
      expect(
        await screen.findByRole('group', { name: 'Request K 7 M R, 4 X Q 9, H T 3 W' })
      ).toBeVisible();
    });

    it('opens nothing for an id that is not a held action’s', () => {
      const replaceState = vi.fn();
      const opened = openActionStepUpFromLink(
        { href: 'https://dorkos.example/?confirm=../../settings' },
        { replaceState, state: null }
      );
      expect(opened).toBe(false);
      expect(replaceState).toHaveBeenCalledOnce();
      expect(getActionStepUpShowing()).toBeNull();
    });
  });

  it('says it took too long on the sheet that follows an expired one', async () => {
    heldWith(VIEW, [200, { ok: true, status: 200, result: {} }]);
    render(<ActionStepUpHost />);
    act(() => {
      void requestActionStepUp('held-2', { afterExpiry: true });
    });
    expect(await screen.findByText('This took too long. Confirm it’s you again.')).toBeTruthy();
  });

  it('names the button for Confirm this setting', async () => {
    heldWith({ ...VIEW, kind: 'connection.confirm-setting', notes: [] }, [
      200,
      { ok: true, status: 200, result: {} },
    ]);
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByRole('button', { name: 'Confirm setting' })).toBeTruthy();
  });

  it('names the button for a connection that will send your setting', async () => {
    heldWith({ ...VIEW, kind: 'connection.use-setting', notes: [] }, [
      200,
      { ok: true, status: 200, result: {} },
    ]);
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByRole('button', { name: 'Allow sending' })).toBeTruthy();
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

  it('offers no password while a mini app can be edited by an agent, and says how to fix it', async () => {
    heldWith(
      {
        ...VIEW,
        methods: [],
        passwordUnavailable: 'extension-risk',
        blockedBy: [
          { id: 'sq', name: 'Social queue', reason: 'agent-folder', agentName: 'dorkos-marketing' },
          { id: 'notes', name: 'Notes', reason: 'changed' },
        ],
      },
      [200, { ok: true, status: 200, result: {} }]
    );
    render(<ActionStepUpHost />);
    const outcome = ask();
    expect(
      await screen.findByText(
        'Confirming is off while Social queue can be edited by dorkos-marketing.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText('Confirming is off while Notes has changed since you approved it.')
    ).toBeTruthy();
    expect(screen.queryByLabelText('DorkOS password')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'How to fix' }));
    await expect(outcome).resolves.toEqual({ kind: 'not-confirmed' });
  });

  it('shows a mini app’s name as plain text: its author picks it (DOR-4906)', async () => {
    const name = '<img src="x" alt="planted">Notes';
    heldWith(
      {
        ...VIEW,
        methods: [],
        passwordUnavailable: 'extension-risk',
        blockedBy: [{ id: 'notes', name, reason: 'changed' }],
      },
      [200, { ok: true, status: 200, result: {} }]
    );
    render(<ActionStepUpHost />);
    void ask();
    expect(
      await screen.findByText(`Confirming is off while ${name} has changed since you approved it.`)
    ).toBeTruthy();
    expect(screen.queryByAltText('planted')).toBeNull();
  });

  it('after a mini app ran since sign-in, drops this hold and asks to sign in again', async () => {
    const fetchSpy = heldWith({ ...VIEW, methods: [], passwordUnavailable: 'stale-sign-in' }, [
      200,
      { ok: true, status: 200, result: {} },
    ]);
    render(<ActionStepUpHost />);
    const outcome = ask();
    expect(
      await screen.findByText(
        'Something changed after you signed in. Sign in again, then try once more.'
      )
    ).toBeTruthy();
    expect(screen.queryByLabelText('DorkOS password')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await expect(outcome).resolves.toEqual({ kind: 'sign-in-again' });
    const dropped = fetchSpy.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === 'DELETE'
    );
    expect(String(dropped?.[0])).toMatch(/\/step-up\/held-1$/);
  });

  describe('a page too old to confirm from (DOR-5086)', () => {
    const STALE: HeldStepUpView = { ...VIEW, methods: [], passwordUnavailable: 'stale-page' };
    const STALE_LINE = 'This page opened before a change. Reload it, then try again.';

    /** Wait past the moment the page would have reloaded by itself. */
    const pastTheReload = () => new Promise((resolve) => setTimeout(resolve, 600));

    it('says so, then reloads once by itself and reopens this action there', async () => {
      heldWith(STALE, [200, {}]);
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask();
      expect(await screen.findByText('Updating this page…')).toBeVisible();
      expect(screen.queryByLabelText('DorkOS password')).toBeNull();
      await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
      const url = new URL(String(navigate.mock.calls[0]?.[0]));
      // Only the id travels: the new page asks the server what it is.
      expect(url.searchParams.get('confirm')).toBe('held-1');
      expect(url.origin).toBe(window.location.origin);
    });

    it('never reloads twice for one action: the second time it offers the Reload button', async () => {
      heldWith(STALE, [200, {}]);
      expect(noteStepUpReload('held-1')).toBe(true);
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask();
      expect(await screen.findByText(STALE_LINE)).toBeVisible();
      await pastTheReload();
      expect(navigate).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('DorkOS password')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(navigate).toHaveBeenCalledOnce();
    });

    it('never reloads by itself when nothing could record that it did', async () => {
      heldWith(STALE, [200, {}]);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask();
      expect(await screen.findByText(STALE_LINE)).toBeVisible();
      await pastTheReload();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('keeps what was typed on the page: no reload by itself, and Reload says what it clears', async () => {
      const draft = document.createElement('textarea');
      draft.value = 'A half-written made-up message';
      document.body.append(draft);
      heldWith(STALE, [200, {}]);
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask();
      expect(await screen.findByText(STALE_LINE)).toBeVisible();
      expect(screen.getByText('Reloading clears what you typed on this page.')).toBeVisible();
      await pastTheReload();
      expect(navigate).not.toHaveBeenCalled();
      expect(draft.value).toBe('A half-written made-up message');
    });

    it('reopens the same held action on the reloaded page', async () => {
      const id = '01M83PFTJC1PT56MGDM44ZXQ7W';
      heldWith({ ...STALE, heldActionId: id }, [200, {}]);
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask(id);
      await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
      act(() => finishActionStepUp(id, { kind: 'not-confirmed' }));
      // The fresh page reads the address it was loaded with.
      const replaceState = vi.fn();
      let opened = false;
      act(() => {
        opened = openActionStepUpFromLink(
          { href: String(navigate.mock.calls[0]?.[0]) },
          { replaceState, state: null }
        );
      });
      expect(opened).toBe(true);
      expect(getActionStepUpShowing()).toBe(id);
      expect(String(replaceState.mock.calls[0]?.[2])).not.toContain('confirm=');
    });

    it('never reloads by itself while another confirm waits behind this one', async () => {
      heldWith(STALE, [200, {}]);
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask('held-1');
      void ask('held-2');
      expect(await screen.findByText(STALE_LINE)).toBeVisible();
      await pastTheReload();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('shows the Reload body when the password step is refused as too old', async () => {
      heldWith(VIEW, [409, { code: 'stale-page', error: STALE_LINE, stale: 'stale-page' }]);
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask();
      await confirmWith('correct horse battery');
      expect(await screen.findByText(STALE_LINE)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
      expect(screen.queryByLabelText('DorkOS password')).toBeNull();
    });

    it('reads the named reason first, in the shape a page with no stamp gets', async () => {
      heldWith(
        {
          ...VIEW,
          methods: [],
          passwordUnavailable: 'extension-risk',
          blockedBy: [],
          stale: 'stale-sign-in',
        },
        [200, {}]
      );
      render(<ActionStepUpHost />);
      void ask();
      expect(
        await screen.findByText(
          'Something changed after you signed in. Sign in again, then try once more.'
        )
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: 'How to fix' })).toBeNull();
    });

    it('never reloads for a mini app that is really there: it stays named', async () => {
      heldWith(
        {
          ...VIEW,
          methods: [],
          passwordUnavailable: 'extension-risk',
          blockedBy: [{ id: 'notes', name: 'Made-up Notes', reason: 'changed' }],
        },
        [200, {}]
      );
      const navigate = vi.fn();
      render(<ActionStepUpHost navigate={navigate} />);
      void ask();
      expect(
        await screen.findByText(
          'Confirming is off while Made-up Notes has changed since you approved it.'
        )
      ).toBeVisible();
      await pastTheReload();
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  it('keeps terminal commands off a remote sheet with no password', async () => {
    heldWith(
      { ...VIEW, methods: [], answeringRemotely: true, passwordUnavailable: 'no-password' },
      [200, { ok: true, status: 200, result: {} }]
    );
    render(<ActionStepUpHost />);
    void ask();
    expect(await screen.findByText('Set one on the computer running DorkOS.')).toBeVisible();
    expect(screen.queryByText('dorkos auth reset-password')).not.toBeInTheDocument();
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

    // Purpose: on Nov 21 the owner lost the password window and nothing said
    // where it was or what closing it did (DOR-4909).
    it('names the shell’s window, and says closing it changes nothing', async () => {
      (window as { electronAPI?: unknown }).electronAPI = {
        confirmStepUp: () => new Promise(() => undefined),
      };
      render(<ActionStepUpHost />);
      void ask();
      expect(await screen.findByText(DESKTOP_SHEET_LINE)).toBeTruthy();
      expect(screen.queryByLabelText('DorkOS password')).toBeNull();
    });

    it('ends unconfirmed when the shell’s window is closed, so the caller can say so', async () => {
      let closeWindow: (outcome: { kind: 'not-confirmed' }) => void = () => undefined;
      (window as { electronAPI?: unknown }).electronAPI = {
        confirmStepUp: () =>
          new Promise((resolve) => {
            closeWindow = resolve;
          }),
      };
      render(<ActionStepUpHost />);
      // Its own id: the shell is asked once per held action, and the test above
      // leaves its window open on `held-1`.
      const outcome = ask('held-closed');
      expect(await screen.findByText(DESKTOP_SHEET_LINE)).toBeTruthy();
      act(() => closeWindow({ kind: 'not-confirmed' }));
      await expect(outcome).resolves.toEqual({ kind: 'not-confirmed' });
      await waitFor(() => expect(screen.queryByText(DESKTOP_SHEET_LINE)).toBeNull());
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
