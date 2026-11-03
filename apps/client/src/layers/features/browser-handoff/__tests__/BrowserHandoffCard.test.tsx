// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  LocalBrowserHandoff,
  LocalBrowserPersonState,
  LocalBrowserSignIn,
} from '@dorkos/shared/local-browser';
import { BrowserHandoffCard, HANDED_BACK_MESSAGE } from '../index';

const transport = vi.hoisted(() => ({
  getLocalBrowserState: vi.fn(),
  handBackLocalBrowser: vi.fn(),
  stopLocalBrowserHandoff: vi.fn(),
  signInLocalBrowser: vi.fn(),
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

    it('in the Mac app’s built-in browser, says not to type it there and offers only Stop task', async () => {
      transport.getLocalBrowserState.mockResolvedValue(
        person({ handoff: password, mode: 'embedded' })
      );
      mount();
      expect(await button('Stop task')).toBeTruthy();
      expect(screen.getByText(/Don’t type it in this panel/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Sign in to/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
    });

    it('still offers Continue for a check with no password in the built-in browser', async () => {
      transport.getLocalBrowserState.mockResolvedValue(person({ mode: 'embedded' }));
      mount();
      expect(await button('Continue')).toBeTruthy();
    });
  });

  it('follows the server’s change event', async () => {
    transport.getLocalBrowserState.mockResolvedValue(person());
    mount();
    await button('Continue');
    expect(events.has('local_browser_changed')).toBe(true);
  });
});
