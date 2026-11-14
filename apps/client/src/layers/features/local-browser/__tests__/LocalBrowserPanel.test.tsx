// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalBrowserCapabilities, LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserPanel } from '../ui/LocalBrowserPanel';
import { useSessionListStore } from '@/layers/entities/session';
import { useAppStore } from '@/layers/shared/model';
import { STORAGE_KEYS } from '@/layers/shared/lib/constants';
import { readLocalBrowserChoice } from '@/layers/shared/model/app-store/local-browser-preference';

const transport = vi.hoisted(() => ({
  getLocalBrowserState: vi.fn(),
  getLocalBrowserCapabilities: vi.fn(),
  openLocalBrowser: vi.fn(),
  pauseLocalBrowser: vi.fn(),
  resumeLocalBrowser: vi.fn(),
  disconnectLocalBrowser: vi.fn(),
  selectLocalBrowserTab: vi.fn(),
  navigateLocalBrowser: vi.fn(),
  interruptSession: vi.fn(),
  getSession: vi.fn(),
  getAgentByPath: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
}));
const disconnected: LocalBrowserState = {
  connectionId: null,
  sessionId: null,
  mode: null,
  status: 'disconnected',
  paused: false,
  tabs: [],
  selectedTabId: null,
  revision: 0,
  preparation: null,
};
const connected: LocalBrowserState = {
  ...disconnected,
  connectionId: 'owned',
  sessionId: 'chat-one',
  mode: 'new-window',
  status: 'connected',
  tabs: [
    { id: 'one', title: 'First page', url: 'https://example.com' },
    { id: 'two', title: 'Second page', url: 'https://example.org' },
  ],
  selectedTabId: 'one',
};
const capabilities: LocalBrowserCapabilities = {
  embedded: false,
  newWindow: true,
  defaultMode: 'new-window',
  platform: 'darwin',
  managedChromiumVersion: '157.0.8103.15',
  unavailableReasons: {},
  playwrightVersion: '1.65.0-alpha-2026-10-30',
};
function holdOpening() {
  let resolve!: (state: LocalBrowserState) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<LocalBrowserState>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  transport.openLocalBrowser.mockReturnValue(promise);
  return { resolve, reject };
}
function mount(visible = true, sessionId: string | null = 'chat-one') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LocalBrowserPanel visible={visible} sessionId={sessionId} agentName="Kai" />
    </QueryClientProvider>
  );
  return { ...view, client };
}
beforeEach(() => {
  vi.resetAllMocks();
  delete window.electronAPI;
  localStorage.clear();
  useAppStore.setState({ localBrowserChoice: null, localBrowserChoiceIssue: null });
  transport.getLocalBrowserState.mockResolvedValue(disconnected);
  transport.getLocalBrowserCapabilities.mockResolvedValue(capabilities);
  transport.openLocalBrowser.mockResolvedValue(connected);
  // The holder chat's title and folder, and no agent there, unless a test says otherwise.
  transport.getSession.mockImplementation(async (id: string) => {
    if (id !== 'other-chat') throw new Error('not found');
    return { id, title: 'Quarterly invoices', cwd: '/agents/scout' };
  });
  transport.getAgentByPath.mockResolvedValue(null);
});
afterEach(() => {
  delete window.electronAPI;
  vi.restoreAllMocks();
});

describe('LocalBrowserPanel', () => {
  it('never labels another chat’s browser with the current agent name', async () => {
    transport.getLocalBrowserState.mockResolvedValue({ ...connected, sessionId: 'other-chat' });
    mount();
    expect(await screen.findByRole('button', { name: 'Quarterly invoices' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Shared with Kai')).not.toBeInTheDocument();
  });
  describe('while another chat holds the browser (DOR-4265)', () => {
    const elsewhere = { ...connected, sessionId: 'other-chat' };
    afterEach(() => useSessionListStore.setState({ statuses: {} }));
    it('names that chat by its title, links to it, and starts focus on Take it here', async () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      transport.getAgentByPath.mockResolvedValue({ name: 'scout', displayName: 'Scout' });
      transport.getLocalBrowserState.mockResolvedValue(elsewhere);
      mount();
      const take = await screen.findByRole('button', { name: 'Take it here' });
      await waitFor(() => expect(take).toHaveFocus());
      expect(screen.getByText('This browser is open in another chat')).toBeInTheDocument();
      expect(
        await screen.findByText(/has it\. One chat uses a browser at a time\./)
      ).toBeInTheDocument();
      // The body says where it is; the header adds no line of its own.
      expect(screen.getAllByRole('status')[0]).toHaveTextContent('');
      fireEvent.click(screen.getByRole('button', { name: 'Quarterly invoices' }));
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ search: expect.objectContaining({ session: 'other-chat' }) })
      );
      // Nothing of that chat but its title: no tabs, address, or controls for its page.
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByLabelText('Web address')).toBeNull();
      expect(screen.queryByText('First page')).toBeNull();
      expect(screen.queryByText(/Shared with another chat/)).toBeNull();
      expect(screen.queryByText(/loses it/)).toBeNull();
      for (const name of ['Pause agent', 'Resume agent', 'Disconnect', 'Use it here'])
        expect(screen.queryByRole('button', { name })).toBeNull();
    });
    it('while that chat’s agent works, says taking it stops that work', async () => {
      useSessionListStore.setState({ statuses: { 'other-chat': {} as never } });
      transport.getAgentByPath.mockResolvedValue({ name: 'scout', displayName: 'Scout' });
      transport.getLocalBrowserState.mockResolvedValue(elsewhere);
      mount();
      const take = await screen.findByRole('button', { name: 'Take it from Scout' });
      expect(
        screen.getByText(
          (_, element) =>
            element?.tagName === 'P' &&
            element.textContent ===
              'Scout is using it in Quarterly invoices right now. Taking it stops what Scout is doing there.'
        )
      ).toBeInTheDocument();
      fireEvent.click(take);
      await waitFor(() =>
        expect(transport.openLocalBrowser).toHaveBeenCalledExactlyOnceWith({
          mode: 'new-window',
          sessionId: 'chat-one',
        })
      );
    });
    it('says "another chat", with no link, when the title is unknown', async () => {
      transport.getSession.mockRejectedValue(new Error('not found'));
      transport.getLocalBrowserState.mockResolvedValue(elsewhere);
      mount();
      expect(
        await screen.findByText('Another chat has it. One chat uses a browser at a time.')
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    });
    it('shows a long title in full, wrapping rather than cutting off', async () => {
      const long = 'A very long chat title about the quarterly invoices for every client';
      transport.getSession.mockResolvedValue({
        id: 'other-chat',
        title: long,
        cwd: '/agents/scout',
      });
      transport.getLocalBrowserState.mockResolvedValue(elsewhere);
      mount();
      const link = await screen.findByRole('button', { name: long });
      expect(link).toHaveTextContent(long);
      expect(link).toHaveClass('whitespace-normal');
      expect(link.querySelector('.truncate')).toBeNull();
    });
    it('Take it here opens the browser for this chat in one click', async () => {
      transport.getLocalBrowserState.mockResolvedValue(elsewhere);
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Take it here' }));
      await waitFor(() =>
        expect(transport.openLocalBrowser).toHaveBeenCalledExactlyOnceWith({
          mode: 'new-window',
          sessionId: 'chat-one',
        })
      );
      expect(await screen.findByLabelText('Shared with Kai')).toBeInTheDocument();
    });
    it('in a room, names the chat but offers no take', async () => {
      transport.getLocalBrowserState.mockResolvedValue(elsewhere);
      mount(true, null);
      expect(await screen.findByRole('button', { name: 'Quarterly invoices' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Take it here' })).toBeNull();
      expect(
        screen.getByText('Open a direct chat with an agent to share it there.')
      ).toBeInTheDocument();
    });
  });
  it('with nothing open, Open browser is the one filled button and a browser is preselected', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    mount();
    const openButton = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(openButton).toBeEnabled());
    await waitFor(() => expect(openButton).toHaveFocus());
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Not open yet');
    expect(screen.getByRole('radio', { checked: true })).toBeInTheDocument();
    const filled = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('data-variant') === 'primary');
    expect(filled).toEqual([openButton]);
  });
  describe('while another chat’s agent waits on a person', () => {
    const elsewhere = {
      id: 'h1',
      sessionId: 'chat-two',
      agentName: 'Atlas',
      agentId: null,
      agentFolder: null,
      profileId: null,
      reason: 'wall',
      site: 'example.com',
      askedAt: '2026-11-03T00:00:00.000Z',
      outcome: null,
    };
    it('with its window open, the header adds no line of its own', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...connected,
        sessionId: 'chat-two',
        paused: true,
        handoff: elsewhere,
        signIn: null,
      });
      mount();
      await screen.findByRole('button', { name: 'Open that chat' });
      expect(screen.getAllByRole('status')[0]).toHaveTextContent('');
      expect(screen.queryByRole('button', { name: 'Take it here' })).toBeNull();
    });
    it.each([
      ['with its window open', { ...connected, sessionId: 'chat-two', paused: true }],
      ['with its window closed', { ...disconnected, sessionId: 'chat-two' }],
    ])('%s, offers only that chat', async (_case, browser) => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...browser,
        handoff: elsewhere,
        signIn: null,
      });
      mount();
      expect(
        await screen.findByText(
          (_, element) =>
            element?.tagName === 'P' &&
            element.textContent ===
              'Atlas in another chat is waiting for you to finish signing in here.'
        )
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Open that chat' }));
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ search: expect.objectContaining({ session: 'chat-two' }) })
      );
      for (const name of [
        'Resume agent',
        'Pause agent',
        'Disconnect',
        'Open browser',
        'Reconnect',
        'Take it here',
      ])
        expect(screen.queryByRole('button', { name })).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByLabelText('Web address')).toBeNull();
      // Forget stays out of reach too: nothing here may change that chat's browser.
      expect(screen.queryByLabelText('Saved sign-ins')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Forget…' })).toBeNull();
    });
    it('names the waiting agent and links its chat by title', async () => {
      transport.getSession.mockResolvedValue({
        id: 'chat-two',
        title: 'Book the venue',
        cwd: '/agents/atlas',
      });
      transport.getLocalBrowserState.mockResolvedValue({
        ...connected,
        sessionId: 'chat-two',
        paused: true,
        handoff: elsewhere,
        signIn: null,
      });
      mount();
      const link = await screen.findByRole('button', { name: 'Book the venue' });
      expect(link.closest('p')).toHaveTextContent(
        'Atlas in Book the venue is waiting for you to finish signing in here.'
      );
      expect(screen.getByText('Atlas').tagName).toBe('STRONG');
      fireEvent.click(link);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ search: expect.objectContaining({ session: 'chat-two' }) })
      );
    });
    it('keeps the ordinary controls when that handoff has ended', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...connected,
        sessionId: 'chat-two',
        handoff: { ...elsewhere, outcome: 'stopped' },
        signIn: null,
      });
      mount();
      expect(await screen.findByRole('button', { name: 'Take it here' })).toBeEnabled();
      expect(await screen.findByLabelText('Saved sign-ins')).toBeInTheDocument();
    });
    it('keeps the controls in the waiting chat’s own panel', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...connected,
        handoff: { ...elsewhere, sessionId: 'chat-one' },
        signIn: null,
      });
      mount();
      expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.queryByText(/is waiting for you to finish signing in here/)).toBeNull();
    });
  });
  describe('while this chat’s agent waits on a person in its own window (DOR-4325)', () => {
    const here = {
      id: 'h1',
      sessionId: 'chat-one',
      agentName: 'Atlas',
      agentId: null,
      agentFolder: null,
      profileId: null,
      reason: 'password',
      site: 'northwind.example',
      askedAt: '2026-11-03T00:00:00.000Z',
      outcome: null,
    };
    // The handoff closed the agent's window for the sign-in window.
    const signingIn = {
      ...disconnected,
      handoff: here,
      signIn: {
        profileId: null,
        site: 'northwind.example',
        status: 'open',
        startedAt: '2026-11-03T00:00:01.000Z',
      },
    };
    it('says it is waiting for you and where to finish, with no Open browser', async () => {
      transport.getLocalBrowserState.mockResolvedValue(signingIn);
      mount();
      expect(await screen.findByText('Waiting for you')).toBeInTheDocument();
      expect(
        screen.getByText('Kai needs you to sign in to northwind.example.')
      ).toBeInTheDocument();
      const next = screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent === 'Finish in the sign-in window, then press Continue in the chat.'
      );
      expect(within(next).getByText('Continue in the chat').tagName).toBe('STRONG');
      expect(screen.queryByText('Not open yet')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Open browser' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    });
    it('keeps Open browser once that handoff has ended', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...signingIn,
        handoff: { ...here, outcome: 'handed-back' },
      });
      mount();
      expect(await screen.findByRole('button', { name: 'Open browser' })).toBeInTheDocument();
      expect(screen.queryByText('Waiting for you')).toBeNull();
    });
    it('after a signing_in refusal, reads the browser again and lands on Waiting for you', async () => {
      transport.openLocalBrowser.mockRejectedValue(
        Object.assign(new Error('Finish signing in first.'), { code: 'signing_in', status: 409 })
      );
      mount();
      const open = await screen.findByRole('button', { name: 'Open browser' });
      await waitFor(() => expect(open).toBeEnabled());
      // The handoff began after this panel last read the browser.
      transport.getLocalBrowserState.mockResolvedValue(signingIn);
      fireEvent.click(open);
      // At once, not on the next one-second poll.
      expect(
        await screen.findByText('Waiting for you', undefined, { timeout: 300 })
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open browser' })).toBeNull();
      // The state already says it, so "Finish…" isn't said twice.
      expect(screen.queryByRole('alert')).toBeNull();
    });
    it('says the sign-in window closed once it has, and still waits for you', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...signingIn,
        signIn: { ...signingIn.signIn, status: 'saved' },
      });
      mount();
      expect(await screen.findByText('Waiting for you')).toBeInTheDocument();
      const next = screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent ===
            'The sign-in window closed. Press Continue in the chat to hand it back.'
      );
      expect(within(next).getByText('Continue in the chat').tagName).toBe('STRONG');
      expect(screen.queryByText(/Finish in the sign-in window/)).toBeNull();
    });
  });
  it('shows the server’s signing_in refusal, not a reconnect hint (DOR-4325)', async () => {
    transport.openLocalBrowser.mockRejectedValue(
      Object.assign(new Error('Finish signing in first.'), { code: 'signing_in', status: 409 })
    );
    mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Finish signing in first. The sign-in window is open.'
    );
  });
  describe('Disconnect during a handoff', () => {
    const handoff = {
      id: 'h1',
      sessionId: 'chat-one',
      agentName: 'Kai',
      agentId: null,
      agentFolder: null,
      profileId: null,
      reason: 'wall',
      site: 'example.com',
      askedAt: '2026-11-03T00:00:00.000Z',
      outcome: null,
    };
    it('takes the ended handoff from the answer and ends the agent’s turn', async () => {
      transport.getLocalBrowserState.mockResolvedValue({ ...connected, handoff, signIn: null });
      transport.interruptSession.mockResolvedValue(undefined);
      transport.disconnectLocalBrowser.mockResolvedValue({
        ...disconnected,
        handoff: { ...handoff, outcome: 'window-closed' },
        signIn: null,
      });
      const view = mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
      await waitFor(() =>
        expect(transport.interruptSession).toHaveBeenCalledExactlyOnceWith('chat-one')
      );
      expect(view.client.getQueryData(['local-browser', 'state'])).toMatchObject({
        handoff: { outcome: 'window-closed' },
      });
    });
    it.each([
      ['handed back before the answer', { ...handoff, outcome: 'handed-back' }],
      ['stopped before the answer', { ...handoff, outcome: 'stopped' }],
      ['replaced by another handoff', { ...handoff, id: 'h2', outcome: 'window-closed' }],
    ])('leaves the turn alone when the handoff was %s', async (_case, answered) => {
      transport.getLocalBrowserState.mockResolvedValue({ ...connected, handoff, signIn: null });
      transport.disconnectLocalBrowser.mockResolvedValue({
        ...disconnected,
        handoff: answered,
        signIn: null,
      });
      const view = mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
      await waitFor(() =>
        expect(view.client.getQueryData(['local-browser', 'state'])).toMatchObject({
          handoff: answered,
        })
      );
      await act(async () => {});
      expect(transport.interruptSession).not.toHaveBeenCalled();
    });
    it('leaves the turn alone when the browser wouldn’t close', async () => {
      transport.getLocalBrowserState.mockResolvedValue({ ...connected, handoff, signIn: null });
      transport.disconnectLocalBrowser.mockRejectedValue(
        Object.assign(new Error('closing'), { code: 'busy' })
      );
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
      await waitFor(() => expect(transport.disconnectLocalBrowser).toHaveBeenCalledOnce());
      await screen.findByText(/Browser is busy|Couldn’t reach the browser/);
      expect(transport.interruptSession).not.toHaveBeenCalled();
    });
    it('interrupts nothing with no handoff open', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
      await waitFor(() => expect(transport.disconnectLocalBrowser).toHaveBeenCalledOnce());
      await screen.findByRole('button', { name: 'Open browser' });
      expect(transport.interruptSession).not.toHaveBeenCalled();
    });
  });
  it('remembers an owned browser choice through disconnect and remount without reopening', async () => {
    transport.openLocalBrowser.mockImplementation(async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      return connected;
    });
    transport.disconnectLocalBrowser.mockImplementation(async () => {
      transport.getLocalBrowserState.mockResolvedValue(disconnected);
      return disconnected;
    });
    const first = mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(await screen.findByRole('heading', { name: 'Agent browser' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Shared with Kai')).toHaveValue('one');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Open browser' })).toBeEnabled();
    first.unmount();
    mount();
    expect(await screen.findByRole('radio', { name: /^In its own window/ })).toBeChecked();
    expect(useAppStore.getState().localBrowserChoice).toEqual({ mode: 'new-window' });
    expect(transport.openLocalBrowser).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
  it('keeps an unsupported saved mode instead of silently switching browsers', async () => {
    useAppStore.getState().setLocalBrowserChoice({ mode: 'embedded' });
    mount();
    expect(await screen.findByRole('radio', { name: /^In DorkOS/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^In its own window/ })).not.toBeChecked();
    expect(screen.getByText('Requires the DorkOS desktop app.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open browser' })).toBeDisabled();
    expect(transport.openLocalBrowser).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'returns a retired preference to the surface default (desktop=%s)',
    async (desktop) => {
      if (desktop) {
        window.electronAPI = {
          localBrowser: { setBounds: vi.fn().mockResolvedValue(undefined) },
        } as unknown as ElectronAPI;
        transport.getLocalBrowserCapabilities.mockResolvedValue({
          ...capabilities,
          embedded: true,
        });
      }
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_BROWSER_CHOICE,
        JSON.stringify({ mode: 'existing', channel: 'msedge' })
      );
      const restored = readLocalBrowserChoice();
      useAppStore.setState({
        localBrowserChoice: restored.choice,
        localBrowserChoiceIssue: restored.issue,
      });
      mount();
      const expected = desktop ? /^In DorkOS/ : /^In its own window/;
      await waitFor(() => expect(screen.getByRole('radio', { name: expected })).toBeChecked());
      expect(screen.getAllByRole('radio')).toHaveLength(2);
      expect(
        screen.queryByRole('radio', { name: /Your existing browser/ })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(transport.openLocalBrowser).not.toHaveBeenCalled();
    }
  );
  it('asks for an explicit browser choice when the saved preference cannot be read', async () => {
    useAppStore.setState({ localBrowserChoice: null, localBrowserChoiceIssue: 'invalid' });
    mount();
    expect(
      await screen.findByText('Choose a browser. The saved choice couldn’t be read.')
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Open browser' })).toBeDisabled();
    const choice = screen.getByRole('radio', { name: /^In its own window/ });
    await waitFor(() => expect(choice).toBeEnabled());
    fireEvent.click(choice);
    expect(screen.getByRole('button', { name: 'Open browser' })).toBeEnabled();
    expect(useAppStore.getState().localBrowserChoice).toEqual({
      mode: 'new-window',
    });
  });
  it('shows genuine current-component progress and removes it after cancellation', async () => {
    const opening = holdOpening();
    transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
    const view = mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    await screen.findByText('Preparing browser');
    await waitFor(() => expect(transport.openLocalBrowser).toHaveBeenCalledTimes(1));
    const preparing: LocalBrowserState = {
      ...disconnected,
      connectionId: 'preparing',
      sessionId: 'chat-one',
      mode: 'new-window',
      preparation: { stage: 'downloading', component: 'chromium', percent: 37 },
    };
    act(() =>
      view.client.setQueryData(['local-browser', 'state'], preparing, {
        updatedAt: Date.now() + 1000,
      })
    );
    expect(await screen.findByText('Downloading the browser…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Browser download' })).toHaveAttribute(
      'value',
      '37'
    );
    act(() =>
      view.client.setQueryData(
        ['local-browser', 'state'],
        {
          ...preparing,
          preparation: { stage: 'downloading', component: 'headless-shell', percent: null },
        },
        { updatedAt: Date.now() + 1000 }
      )
    );
    expect(await screen.findByText('Downloading browser support…')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    act(() =>
      view.client.setQueryData(
        ['local-browser', 'state'],
        { ...preparing, preparation: { stage: 'downloading', component: 'ffmpeg', percent: 5 } },
        { updatedAt: Date.now() + 1000 }
      )
    );
    expect(
      await screen.findByRole('progressbar', { name: 'Video support download' })
    ).toHaveAttribute('value', '5');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByText('Cancelling…');
    expect(open).toBeDisabled();
    await act(async () => opening.resolve(disconnected));
    await waitFor(() => expect(open).toBeEnabled());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    act(() =>
      view.client.setQueryData(['local-browser', 'state'], preparing, {
        updatedAt: Date.now() + 1000,
      })
    );
    await screen.findByRole('button', { name: 'Reconnect' });
    expect(screen.queryByText('Downloading the browser…')).not.toBeInTheDocument();
  });
  it('ignores preparation from another chat and from the previous connection', async () => {
    const previous: LocalBrowserState = {
      ...disconnected,
      connectionId: 'previous',
      sessionId: 'chat-one',
      mode: 'new-window',
      preparation: { stage: 'downloading', component: 'chromium', percent: 70 },
    };
    transport.getLocalBrowserState.mockResolvedValue(previous);
    transport.openLocalBrowser.mockReturnValue(new Promise(() => {}));
    const view = mount();
    const open = await screen.findByRole('button', { name: 'Reconnect' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    await screen.findByText('Preparing browser');
    act(() =>
      view.client.setQueryData(['local-browser', 'state'], previous, {
        updatedAt: Date.now() + 1000,
      })
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    act(() =>
      view.client.setQueryData(
        ['local-browser', 'state'],
        { ...previous, connectionId: 'foreign', sessionId: 'another-chat' },
        { updatedAt: Date.now() + 1000 }
      )
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
  it('explains embedded extra windows as human-only', async () => {
    transport.getLocalBrowserState.mockResolvedValue({ ...connected, mode: 'embedded' });
    mount();
    expect(
      await screen.findByText('Extra windows are for you. Your agent stays on this page.')
    ).toBeInTheDocument();
  });
  it('freezes browser choices until cancellation completes', async () => {
    const opening = holdOpening();
    let finishCancel!: (state: LocalBrowserState) => void;
    transport.disconnectLocalBrowser.mockReturnValue(
      new Promise<LocalBrowserState>((resolve) => {
        finishCancel = resolve;
      })
    );
    mount();
    const mode = await screen.findByRole('radio', { name: /^In its own window/ });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }));
    expect(mode).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelling…')).toBeInTheDocument();
    expect(mode).toBeDisabled();
    await act(async () => finishCancel(disconnected));
    expect(mode).toBeDisabled();
    expect(screen.getByText('Cancelling…')).toBeInTheDocument();
    await act(async () => opening.resolve(disconnected));
    await waitFor(() => expect(mode).toBeEnabled());
  });
  it('returns keyboard focus after cancelling browser setup', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const opening = holdOpening();
    transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
    mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    await act(async () => opening.resolve(disconnected));
    await waitFor(() => expect(open).toHaveFocus());
  });
  it('says "Not open yet" before the browser was ever opened (DOR-4104)', async () => {
    mount();
    expect(await screen.findByText('Not open yet')).toBeInTheDocument();
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
  });

  it('says "Disconnected" only once a connection it saw has gone', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    expect(screen.queryByText('Not open yet')).not.toBeInTheDocument();
  });

  it('returns keyboard focus after disconnecting the browser', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
    mount();
    const disconnect = await screen.findByRole('button', { name: 'Disconnect' });
    disconnect.focus();
    fireEvent.click(disconnect);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open browser' })).toHaveFocus());
  });
  it('does not reclaim keyboard focus when the person moves to the native page', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    transport.getLocalBrowserState.mockResolvedValue(connected);
    let finishDisconnect!: (state: LocalBrowserState) => void;
    transport.disconnectLocalBrowser.mockReturnValue(
      new Promise<LocalBrowserState>((resolve) => {
        finishDisconnect = resolve;
      })
    );
    mount();
    const disconnect = await screen.findByRole('button', { name: 'Disconnect' });
    disconnect.focus();
    fireEvent.click(disconnect);
    hasFocus.mockReturnValue(false);
    fireEvent(window, new Event('blur'));
    await act(async () => finishDisconnect(disconnected));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open browser' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Open browser' })).not.toHaveFocus();
  });
  it('keeps focus on another app control chosen while cancellation finishes', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const opening = holdOpening();
    let finishCancel!: (state: LocalBrowserState) => void;
    transport.disconnectLocalBrowser.mockReturnValue(
      new Promise<LocalBrowserState>((resolve) => {
        finishCancel = resolve;
      })
    );
    mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    const other = document.createElement('button');
    other.textContent = 'Other app control';
    document.body.append(other);
    other.focus();
    await act(async () => finishCancel(disconnected));
    await act(async () => opening.resolve(disconnected));
    await waitFor(() => expect(open).toBeEnabled());
    expect(other).toHaveFocus();
    other.remove();
  });
  it.each([
    [
      'browser_download',
      'raw installer output',
      'Couldn’t download the browser. Check your connection and try again.',
    ],
    [
      'browser_storage',
      'Free some space, then open the browser again.',
      'Free some space, then open the browser again.',
    ],
    [
      'browser_storage',
      'Check folder permissions, then open the browser again.',
      'Check folder permissions, then open the browser again.',
    ],
    [
      'browser_storage',
      '/private/install/path: secret process output',
      'Couldn’t save the browser. Check free space and folder permissions.',
    ],
    ['cancelled', 'raw cancellation error', 'Browser setup stopped. Open it again to continue.'],
    [
      'busy',
      'The browser is still closing. Wait before opening it again.',
      'The browser is still closing. Wait, then try again.',
    ],
    ['busy', 'private busy details', 'Browser is busy. Wait a moment.'],
    [
      'busy',
      'Restart DorkOS to finish closing this browser.',
      'Restart DorkOS to finish closing this browser.',
    ],
  ])('shows safe recovery guidance for %s (%s)', async (code, message, guidance) => {
    transport.openLocalBrowser.mockRejectedValue(Object.assign(new Error(message), { code }));
    mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(await screen.findByRole('alert')).toHaveTextContent(guidance);
    expect(screen.getByRole('button', { name: 'Open browser' })).toBeEnabled();
    if (message !== guidance) expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(transport.openLocalBrowser).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'])(
    'cancels browser setup and fences its late %s result',
    async (outcome) => {
      let resolveOpen!: (state: LocalBrowserState) => void;
      let rejectOpen!: (cause: Error) => void;
      transport.openLocalBrowser.mockReturnValue(
        new Promise<LocalBrowserState>((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        })
      );
      transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
      const view = mount();
      const open = await screen.findByRole('button', { name: 'Open browser' });
      await waitFor(() => expect(open).toBeEnabled());
      fireEvent.click(open);
      expect(await screen.findByText('Preparing browser')).toBeInTheDocument();
      expect(open).toBeDisabled();
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      expect(cancel).toBeEnabled();
      fireEvent.click(cancel);
      await waitFor(() => expect(transport.disconnectLocalBrowser).toHaveBeenCalledTimes(1));
      expect(screen.getByText('Cancelling…')).toBeInTheDocument();
      expect(open).toBeDisabled();
      for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
      await waitFor(() =>
        expect(transport.getLocalBrowserState.mock.calls.length).toBeGreaterThanOrEqual(2)
      );
      await act(async () => {
        if (outcome === 'resolve') resolveOpen(connected);
        else rejectOpen(new Error('The cancelled installer answered late'));
      });
      await waitFor(() => expect(open).toBeEnabled());
      expect(screen.queryByText('Cancelling…')).not.toBeInTheDocument();
      expect(view.client.getQueryData(['local-browser', 'state'])).toEqual(disconnected);
      expect(screen.getByText('Not open yet')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pause agent' })).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(transport.openLocalBrowser).toHaveBeenCalledTimes(1);
    }
  );
  it('allows retry only after the cancelled setup has settled', async () => {
    let first!: (state: LocalBrowserState) => void;
    let second!: (state: LocalBrowserState) => void;
    transport.openLocalBrowser
      .mockImplementationOnce(
        () =>
          new Promise<LocalBrowserState>((resolve) => {
            first = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<LocalBrowserState>((resolve) => {
            second = resolve;
          })
      );
    transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
    const view = mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(open).toBeDisabled();
    await act(async () => first(connected));
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(screen.getByText('Preparing browser')).toBeInTheDocument();
    expect(open).toBeDisabled();
    expect(view.client.getQueryData(['local-browser', 'state'])).toEqual(disconnected);
    await waitFor(() => expect(transport.openLocalBrowser).toHaveBeenCalledTimes(2));
    await act(async () => second({ ...connected, connectionId: 'new-opening' }));
    expect(await screen.findByRole('button', { name: 'Pause agent' })).toBeEnabled();
    expect(view.client.getQueryData(['local-browser', 'state'])).toMatchObject({
      connectionId: 'new-opening',
    });
  });
  it('offers exactly two modes and defaults web to a separate browser window', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /^In DorkOS/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^In its own window/ })).toBeChecked();
    fireEvent.click(button);
    await waitFor(() =>
      expect(transport.openLocalBrowser).toHaveBeenCalledWith({
        mode: 'new-window',
        sessionId: 'chat-one',
      })
    );
    expect(
      await screen.findByText('This page is in the separate browser window.')
    ).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('selects the exact owned tab shared with the current chat', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    mount();
    const next = { ...connected, selectedTabId: 'two' };
    transport.selectLocalBrowserTab.mockResolvedValue(next);
    fireEvent.change(await screen.findByLabelText('Shared with Kai'), {
      target: { value: 'two' },
    });
    await waitFor(() => expect(transport.selectLocalBrowserTab).toHaveBeenCalledWith('two'));
  });
  it('keeps the selected tab when another tab stops responding', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.selectLocalBrowserTab.mockRejectedValue(
      Object.assign(new Error('raw browser focus error'), { code: 'focus_unavailable' })
    );
    mount();
    const tabs = await screen.findByLabelText('Shared with Kai');
    fireEvent.change(tabs, { target: { value: 'two' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This tab stopped responding. Choose it again.'
    );
    expect(tabs).toHaveValue('one');
    expect(screen.queryByText('raw browser focus error')).not.toBeInTheDocument();
    expect(transport.selectLocalBrowserTab).toHaveBeenCalledTimes(1);
  });
  it('pauses agent actions while leaving human controls available', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.pauseLocalBrowser.mockResolvedValue({ ...connected, paused: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause agent' }));
    expect(await screen.findByRole('button', { name: 'Resume agent' })).toBeEnabled();
    expect(screen.getByText('Your mouse and keyboard still work.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go' })).toBeEnabled();
    expect(
      screen.getByText('Pause stops new actions. An action already started may finish.')
    ).toBeInTheDocument();
  });
  it('keeps a typed address when navigation becomes stale and never replays it', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.navigateLocalBrowser.mockRejectedValue(
      Object.assign(new Error('changed'), { code: 'stale_page' })
    );
    mount();
    const address = await screen.findByRole('textbox', { name: 'Web address' });
    fireEvent.change(address, { target: { value: 'https://new.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(
      await screen.findByText('Page changed. Read it again before continuing.')
    ).toBeInTheDocument();
    expect(address).toHaveValue('https://new.example.com');
    expect(transport.navigateLocalBrowser).toHaveBeenCalledTimes(1);
  });
  it.each(['navigation_uncertain', 'uncertain'])(
    'keeps uncertain effects visible without offering a replay (%s)',
    async (code) => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.navigateLocalBrowser.mockRejectedValue(
        Object.assign(new Error('unknown outcome'), { code })
      );
      mount();
      const address = await screen.findByRole('textbox', { name: 'Web address' });
      fireEvent.change(address, { target: { value: 'https://new.example.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect(await screen.findByText('Check what happened before continuing.')).toBeInTheDocument();
      expect(address).toHaveValue('https://new.example.com');
      expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
      expect(transport.navigateLocalBrowser).toHaveBeenCalledTimes(1);
    }
  );
  it('offers reconnect after the browser closes without claiming the page is still open', async () => {
    transport.getLocalBrowserState.mockResolvedValue({ ...connected, status: 'closed', tabs: [] });
    mount();
    expect(await screen.findByText('Browser closed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Shared with Kai')).not.toBeInTheDocument();
  });
  it('defaults supported desktop to its native page and hides it on unmount', async () => {
    const setBounds = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = { localBrowser: { setBounds } } as unknown as ElectronAPI;
    transport.getLocalBrowserCapabilities.mockResolvedValue({ ...capabilities, embedded: true });
    transport.openLocalBrowser.mockResolvedValue({ ...connected, mode: 'embedded' });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    } as DOMRect);
    const view = mount();
    const radio = await screen.findByRole('radio', { name: /^In DorkOS/ });
    await waitFor(() => expect(radio).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }));
    await waitFor(() =>
      expect(setBounds).toHaveBeenCalledWith({
        connectionId: 'owned',
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        visible: true,
      })
    );
    expect(document.querySelector('iframe')).toBeNull();
    view.unmount();
    expect(setBounds).toHaveBeenLastCalledWith({
      connectionId: 'owned',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
    });
  });
  it('hides a native page behind an app dialog and when switching to another chat', async () => {
    const setBounds = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = { localBrowser: { setBounds } } as unknown as ElectronAPI;
    const native = { ...connected, mode: 'embedded' as const };
    transport.getLocalBrowserState.mockResolvedValue(native);
    transport.getLocalBrowserCapabilities.mockResolvedValue({ ...capabilities, embedded: true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    const view = mount();
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(false));
    dialog.remove();
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
    act(() =>
      view.client.setQueryData(['local-browser', 'state'], { ...native, sessionId: 'another-chat' })
    );
    expect(await screen.findByRole('button', { name: 'Take it here' })).toBeInTheDocument();
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(false));
  });
  it('keeps unexpected browser process errors out of recovery copy', async () => {
    transport.openLocalBrowser.mockRejectedValue(new Error('private browser process details'));
    mount();
    const open = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t reach the browser. Reconnect and try again.'
    );
    expect(screen.queryByText('private browser process details')).not.toBeInTheDocument();
  });
  it('clips the native page to the panel instead of covering nearby app controls', async () => {
    const setBounds = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = { localBrowser: { setBounds } } as unknown as ElectronAPI;
    transport.getLocalBrowserState.mockResolvedValue({ ...connected, mode: 'embedded' });
    transport.getLocalBrowserCapabilities.mockResolvedValue({ ...capabilities, embedded: true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return {
        x: 100,
        y: 100,
        width: 400,
        height: this.dataset.testid === 'clip' ? 140 : 300,
      } as DOMRect;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <div data-testid="clip" style={{ overflowY: 'hidden' }}>
          <LocalBrowserPanel sessionId="chat-one" agentName="Kai" />
        </div>
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(setBounds).toHaveBeenCalledWith({
        connectionId: 'owned',
        x: 100,
        y: 100,
        width: 400,
        height: 140,
        visible: true,
      })
    );
  });
});
