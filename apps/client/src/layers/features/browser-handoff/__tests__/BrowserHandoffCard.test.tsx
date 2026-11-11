// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  LocalBrowserHandoff,
  LocalBrowserPersonState,
  LocalBrowserSignIn,
} from '@dorkos/shared/local-browser';
import { BrowserHandoffCard, BrowserHandoffInboxItem, HANDED_BACK_MESSAGE } from '../index';

const transport = vi.hoisted(() => ({
  getLocalBrowserState: vi.fn(),
  handBackLocalBrowser: vi.fn(),
  stopLocalBrowserHandoff: vi.fn(),
  signInLocalBrowser: vi.fn(),
  openLocalBrowser: vi.fn(),
  selectLocalBrowserTab: vi.fn(),
  postMessage: vi.fn(),
  interruptSession: vi.fn(),
}));
const events = vi.hoisted(() => new Map<string, () => void>());
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
  useEventSubscription: (name: string, handler: () => void) => events.set(name, handler),
  useCoalescedInvalidation: () => () => undefined,
}));

const ASKED_AT = '2026-11-03T14:30:00.000Z';
const handoff: LocalBrowserHandoff = {
  id: 'h1',
  sessionId: 'chat-one',
  agentName: 'Atlas',
  agentId: 'agent-1',
  agentFolder: '/work/atlas',
  profileId: 'p1',
  reason: 'wall',
  site: 'northwind.example',
  askedAt: ASKED_AT,
  outcome: null,
};
function person(overrides: Partial<LocalBrowserPersonState> = {}): LocalBrowserPersonState {
  return {
    connectionId: 'c1',
    sessionId: 'chat-one',
    mode: 'new-window',
    status: 'connected',
    paused: true,
    tabs: [{ id: 't1', url: 'https://northwind.example/fares', title: 'Fares' }],
    selectedTabId: 't1',
    revision: 1,
    preparation: null,
    handoff,
    signIn: null,
    ...overrides,
  };
}
const signIn = (
  status: LocalBrowserSignIn['status'],
  startedAt = '2026-11-03T14:31:00.000Z'
): LocalBrowserSignIn => ({ profileId: null, site: 'northwind.example', status, startedAt });

function mount(sessionId: string | null = 'chat-one') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <BrowserHandoffCard sessionId={sessionId} />
    </QueryClientProvider>
  );
}
const button = (name: string) => screen.findByRole('button', { name });

beforeEach(() => {
  vi.resetAllMocks();
  transport.postMessage.mockResolvedValue({ sessionId: 'chat-one' });
  transport.interruptSession.mockResolvedValue({ receipt: 'none', cancelledQueued: [] });
});
afterEach(cleanup);

describe('BrowserHandoffCard', () => {
  it('draws nothing with no handoff, an ended one, or another chat’s', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person({ handoff: null }));
    const none = mount();
    await waitFor(() => expect(transport.getLocalBrowserState).toHaveBeenCalled());
    expect(none.container.querySelector('[data-slot="browser-handoff-card"]')).toBeNull();
    none.unmount();

    transport.getLocalBrowserState.mockResolvedValue(
      person({ handoff: { ...handoff, outcome: 'stopped' } })
    );
    const ended = mount();
    await waitFor(() => expect(transport.getLocalBrowserState).toHaveBeenCalledTimes(2));
    expect(ended.container.querySelector('[data-slot="browser-handoff-card"]')).toBeNull();
    ended.unmount();

    transport.getLocalBrowserState.mockResolvedValue(person());
    const other = mount('chat-two');
    await waitFor(() => expect(transport.getLocalBrowserState).toHaveBeenCalledTimes(3));
    expect(other.container.querySelector('[data-slot="browser-handoff-card"]')).toBeNull();
  });

  it('draws nothing on a phone, where the state read is refused', async () => {
    transport.getLocalBrowserState.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'local_only' })
    );
    const { container } = mount();
    await waitFor(() => expect(transport.getLocalBrowserState).toHaveBeenCalled());
    expect(container.querySelector('[data-slot="browser-handoff-card"]')).toBeNull();
  });

  it('names the real site, the agent and its folder', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    mount();
    expect(
      await screen.findByRole('heading', { name: 'northwind.example wants a person to continue' })
    ).toBeTruthy();
    expect(screen.getByText('Atlas is paused')).toBeTruthy();
    expect(screen.getByText('/work/atlas')).toBeTruthy();
  });

  it('says the agent can’t see or use the window while the person has it (DOR-3111)', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    mount();
    expect(await screen.findByText('Your turn: Atlas can’t see or use this window.')).toBeTruthy();
  });

  it('says it of "The agent" when the call carried no identity', async () => {
    transport.getLocalBrowserState.mockResolvedValue(
      person({ handoff: { ...handoff, agentName: null, agentFolder: null } })
    );
    mount();
    expect(
      await screen.findByText('Your turn: The agent can’t see or use this window.')
    ).toBeTruthy();
  });

  it('shows the home folder as ~', async () => {
    transport.getLocalBrowserState.mockResolvedValue(
      person({ handoff: { ...handoff, agentFolder: '/home/sam/agents/atlas' } })
    );
    mount();
    expect(await screen.findByText('~/agents/atlas')).toBeTruthy();
  });

  it('says "The agent" when the call carried no identity', async () => {
    transport.getLocalBrowserState.mockResolvedValue(
      person({ handoff: { ...handoff, agentName: null, agentFolder: null } })
    );
    mount();
    expect(await screen.findByText('The agent is paused')).toBeTruthy();
  });

  it('strips control and direction characters from an agent’s name', async () => {
    transport.getLocalBrowserState.mockResolvedValue(
      person({ handoff: { ...handoff, agentName: 'At\u202Elas\u200F' } })
    );
    mount();
    expect(await screen.findByText('Atlas is paused')).toBeTruthy();
  });

  it('cuts a long agent name short, and never the folder', async () => {
    const folder = `/work/${'deep/'.repeat(30)}atlas`;
    transport.getLocalBrowserState.mockResolvedValue(
      person({ handoff: { ...handoff, agentName: 'A'.repeat(200), agentFolder: folder } })
    );
    mount();
    expect(await screen.findByText(`${'A'.repeat(40)}… is paused`)).toBeTruthy();
    expect(screen.getByText(folder)).toBeTruthy();
  });

  it('Continue hands back first, then sends the agent its one message', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    transport.handBackLocalBrowser.mockResolvedValue(
      person({ handoff: { ...handoff, outcome: 'handed-back' }, paused: false })
    );
    const { container } = mount();
    fireEvent.click(await button('Continue'));
    await waitFor(() =>
      expect(transport.postMessage).toHaveBeenCalledWith('chat-one', HANDED_BACK_MESSAGE)
    );
    expect(transport.handBackLocalBrowser).toHaveBeenCalledWith('h1');
    expect(transport.handBackLocalBrowser.mock.invocationCallOrder[0]).toBeLessThan(
      transport.postMessage.mock.invocationCallOrder[0]
    );
    await waitFor(() =>
      expect(container.querySelector('[data-slot="browser-handoff-card"]')).toBeNull()
    );
  });

  it('sends no message when Hand back is refused, and says why', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    transport.handBackLocalBrowser.mockRejectedValue(
      Object.assign(new Error('This handoff already ended.'), { code: 'handoff_ended' })
    );
    mount();
    fireEvent.click(await button('Continue'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This handoff already ended.'
    );
    expect(transport.postMessage).not.toHaveBeenCalled();
  });

  it('keeps an unknown server message out of the app', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    transport.handBackLocalBrowser.mockRejectedValue(
      Object.assign(new Error('EACCES /secret/path'), { code: 'browser_error' })
    );
    mount();
    fireEvent.click(await button('Continue'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t reach the browser. Try again.'
    );
  });

  it('Stop task stops the handoff, then ends the turn, and sends no message', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    transport.stopLocalBrowserHandoff.mockResolvedValue(
      person({ handoff: { ...handoff, outcome: 'stopped' } })
    );
    mount();
    fireEvent.click(await button('Stop task'));
    await waitFor(() => expect(transport.interruptSession).toHaveBeenCalledWith('chat-one'));
    expect(transport.stopLocalBrowserHandoff).toHaveBeenCalledWith('h1');
    expect(transport.postMessage).not.toHaveBeenCalled();
  });

  it('Show window raises the agent’s tab and keeps the card', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    transport.selectLocalBrowserTab.mockResolvedValue(person({ handoff: undefined }));
    mount();
    fireEvent.click(await button('Show window'));
    await waitFor(() => expect(transport.selectLocalBrowserTab).toHaveBeenCalledWith('t1'));
    expect(await button('Continue')).toBeTruthy();
  });

  describe('when the window closed', () => {
    const closed = (overrides: Partial<LocalBrowserPersonState> = {}) =>
      person({ status: 'closed', tabs: [], selectedTabId: null, ...overrides });

    it.each(['wall', 'password'] as const)(
      'on a %s handoff, says so and offers only Open window and Stop task',
      async (reason) => {
        transport.getLocalBrowserState.mockResolvedValue(
          closed({ handoff: { ...handoff, reason } })
        );
        mount();
        expect(
          await screen.findByText('The window closed. Open it again to finish, or stop the task.')
        ).toBeInTheDocument();
        const names = screen.getAllByRole('button').map((item) => item.textContent);
        expect(names).toEqual(['Open window', 'Stop task']);
      }
    );

    it('opens for the same chat and profile, naming no page', async () => {
      transport.getLocalBrowserState.mockResolvedValue(closed());
      transport.openLocalBrowser.mockResolvedValue(person());
      mount();
      fireEvent.click(await button('Open window'));
      await waitFor(() =>
        expect(transport.openLocalBrowser).toHaveBeenCalledExactlyOnceWith({
          mode: 'new-window',
          sessionId: 'chat-one',
          profileId: 'p1',
        })
      );
      expect(await button('Continue')).toBeInTheDocument();
    });

    it('leaves out the profile when the handoff is on the default one', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        closed({ handoff: { ...handoff, profileId: null } })
      );
      transport.openLocalBrowser.mockResolvedValue(person());
      mount();
      fireEvent.click(await button('Open window'));
      await waitFor(() =>
        expect(transport.openLocalBrowser).toHaveBeenCalledExactlyOnceWith({
          mode: 'new-window',
          sessionId: 'chat-one',
        })
      );
    });

    it('keeps Continue after a saved sign-in, which closes the window on purpose', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({
          status: 'disconnected',
          sessionId: null,
          tabs: [],
          selectedTabId: null,
          signIn: signIn('saved'),
        })
      );
      mount();
      expect(await button('Continue')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open window' })).toBeNull();
    });

    it('offers Open window after a failed sign-in, when no window is left to retry from', async () => {
      transport.getLocalBrowserState.mockResolvedValue(closed({ signIn: signIn('failed') }));
      mount();
      expect(await button('Open window')).toBeInTheDocument();
    });
  });

  describe('on a check', () => {
    it('warns about a password and offers the plain window, because the agent chose the reason', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person());
      transport.signInLocalBrowser.mockResolvedValue(person({ signIn: signIn('open') }));
      mount();
      expect(
        await screen.findByText('If it asks for a password, don’t type it in Atlas’s window.')
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to northwind.example' }));
      await waitFor(() =>
        expect(transport.signInLocalBrowser).toHaveBeenCalledWith({ handoffId: 'h1' })
      );
      expect(await screen.findByText(/Sign-in window open/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
    });

    it('holds Continue while that sign-in saves, then offers it', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person({ signIn: signIn('saving') }));
      const saving = mount();
      expect((await button('Continue')).getAttribute('aria-disabled')).toBe('true');
      saving.unmount();
      transport.getLocalBrowserState.mockResolvedValue(person({ signIn: signIn('saved') }));
      mount();
      expect((await button('Continue')).getAttribute('aria-disabled')).toBe('false');
    });

    it('says the agent moves, in the Mac app’s panel', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person({ mode: 'embedded' }));
      mount();
      expect(
        await screen.findByText('Atlas moves to its own window after you sign in.')
      ).toBeTruthy();
    });
  });

  describe('on a password page', () => {
    const password = { ...handoff, reason: 'password' as const };

    it('offers the plain window, not Continue', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person({ handoff: password }));
      transport.signInLocalBrowser.mockResolvedValue(
        person({ handoff: password, signIn: signIn('open'), status: 'disconnected' })
      );
      mount();
      fireEvent.click(await button('Sign in to northwind.example'));
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
      await waitFor(() =>
        expect(transport.signInLocalBrowser).toHaveBeenCalledWith({ handoffId: 'h1' })
      );
      expect(await screen.findByText(/Sign-in window open/)).toBeTruthy();
      // That window has no channel to DorkOS, so nothing here could raise it.
      expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    });

    it('holds Continue inert while saving', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: password, signIn: signIn('saving') })
      );
      mount();
      const held = await button('Continue');
      expect(screen.getByRole('status').textContent).toBe('Saving your sign-in…');
      expect(held.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(held);
      expect(transport.handBackLocalBrowser).not.toHaveBeenCalled();
    });

    it('offers Continue once saved', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: password, signIn: signIn('saved') })
      );
      mount();
      expect((await button('Continue')).getAttribute('aria-disabled')).toBe('false');
      expect(screen.getByRole('status').textContent).toBe('Signed in to northwind.example.');
    });

    it('offers Sign in again when saving failed', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: password, signIn: signIn('failed') })
      );
      mount();
      expect(await button('Sign in to northwind.example')).toBeTruthy();
      expect(screen.getByRole('status').textContent).toMatch(/Couldn’t save/);
      expect(screen.getByRole('button', { name: 'Stop task' })).toBeTruthy();
    });

    it('ignores an earlier sign-in, and one for another site', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: password, signIn: signIn('saved', '2026-11-03T14:00:00.000Z') })
      );
      const early = mount();
      expect(await button('Sign in to northwind.example')).toBeTruthy();
      early.unmount();

      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: password, signIn: { ...signIn('saved'), site: 'other.example' } })
      );
      mount();
      expect(await button('Sign in to northwind.example')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    });

    it('in the Mac app’s panel, offers the plain window and says the agent moves', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: password, mode: 'embedded' })
      );
      mount();
      expect(await button('Sign in to northwind.example')).toBeTruthy();
      expect(screen.getByText('Atlas moves to its own window after you sign in.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
    });

    it('says nothing about moving in a new window', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person({ handoff: password }));
      mount();
      await button('Sign in to northwind.example');
      expect(screen.queryByText(/moves to its own window/)).toBeNull();
    });

    it('says every agent can use the sign-in only on the shared profile', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: { ...password, profileId: null } })
      );
      const shared = mount();
      expect(await screen.findByText(/Every agent that uses the Agent browser/)).toBeTruthy();
      shared.unmount();
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: { ...password, profileId: 'p1' } })
      );
      mount();
      await button('Sign in to northwind.example');
      expect(screen.queryByText(/Every agent that uses the Agent browser/)).toBeNull();
    });

    it('still offers Continue for a check with no password in the built-in browser', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person({ mode: 'embedded' }));
      mount();
      expect(await button('Continue')).toBeTruthy();
    });
  });

  describe('in the Inbox', () => {
    function mountItem() {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      return render(
        <QueryClientProvider client={client}>
          <BrowserHandoffInboxItem />
        </QueryClientProvider>
      );
    }

    it('shows whichever handoff is open, and answers it with the chat closed', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person());
      transport.handBackLocalBrowser.mockResolvedValue(
        person({ handoff: { ...handoff, outcome: 'handed-back' } })
      );
      mountItem();
      fireEvent.click(await button('Continue'));
      await waitFor(() =>
        expect(transport.postMessage).toHaveBeenCalledWith('chat-one', HANDED_BACK_MESSAGE)
      );
    });

    it('carries Stop task', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person());
      transport.stopLocalBrowserHandoff.mockResolvedValue(
        person({ handoff: { ...handoff, outcome: 'stopped' } })
      );
      mountItem();
      fireEvent.click(await button('Stop task'));
      await waitFor(() => expect(transport.interruptSession).toHaveBeenCalledWith('chat-one'));
    });

    it('draws nothing when no handoff is open', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person({ handoff: null }));
      const { container } = mountItem();
      await waitFor(() => expect(transport.getLocalBrowserState).toHaveBeenCalled());
      expect(container.querySelector('[data-slot="browser-handoff-card"]')).toBeNull();
    });
  });

  it('follows the server’s change event', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    mount();
    await button('Continue');
    expect(events.has('local_browser_changed')).toBe(true);
  });
});
