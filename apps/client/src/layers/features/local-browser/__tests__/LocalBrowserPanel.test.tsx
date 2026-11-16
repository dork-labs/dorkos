// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalBrowserCapabilities, LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserPanel } from '../ui/LocalBrowserPanel';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/layers/shared/ui';
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
  stepLocalBrowserHistory: vi.fn(),
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

/** Type into the Agent browser's address field and press Enter, as a person would. */
async function typeAddress(typed: string): Promise<void> {
  // After a failure the field stays open on what was typed, so it may be open already.
  if (!screen.queryByRole('textbox', { name: 'Address' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Address:/ }));
  const field = screen.getByRole('textbox', { name: 'Address' });
  fireEvent.change(field, { target: { value: typed } });
  fireEvent.submit(field.closest('form') as HTMLFormElement);
}

/** Open the browser's ⋯ menu from the keyboard, as Radix expects in jsdom. */
async function openMenu(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: 'Browser menu' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.findByRole('menu');
}

/** Choose one item from the browser's ⋯ menu. */
async function chooseFromMenu(name: string): Promise<void> {
  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole('menuitem', { name }));
}

/** Show another of this chat's pages from the menu's Pages group. */
async function choosePage(name: string): Promise<void> {
  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole('menuitemradio', { name }));
}

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
      expect(screen.queryByRole('button', { name: /^Address:/ })).toBeNull();
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
      expect(await screen.findByRole('button', { name: 'Browser menu' })).toBeInTheDocument();
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
        'Browser menu',
        'Open browser',
        'Reconnect',
        'Take it here',
      ])
        expect(screen.queryByRole('button', { name })).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Address:/ })).toBeNull();
      // Forget stays out of reach too: nothing here may change that chat's browser.
      expect(screen.queryByRole('button', { name: /^Forget/ })).toBeNull();
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
      expect(
        await screen.findByRole('button', { name: 'Forget saved sign-ins…' })
      ).toBeInTheDocument();
    });
    it('keeps the controls in the waiting chat’s own panel', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...connected,
        handoff: { ...elsewhere, sessionId: 'chat-one' },
        signIn: null,
      });
      mount();
      expect(await screen.findByRole('button', { name: 'Browser menu' })).toBeInTheDocument();
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
  describe('while this chat’s agent waits on a person in the Mac app (DOR-3111)', () => {
    const here = {
      id: 'h1',
      sessionId: 'chat-one',
      agentName: 'Atlas',
      agentId: null,
      agentFolder: null,
      profileId: null,
      reason: 'wall',
      site: 'northwind.example',
      askedAt: '2026-11-03T00:00:00.000Z',
      outcome: null,
    };
    // In the Mac app the agent's page stays here, paused, while the person has it.
    const handedOver = { ...connected, mode: 'embedded' as const, paused: true };
    const strip = () =>
      screen.queryByText(
        (_, element) =>
          element?.getAttribute('data-slot') === 'your-turn-strip' &&
          element.textContent === 'Your turn: Atlas can’t see or use this window.'
      );
    it('puts the Your turn strip above the page, with the card’s words', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...handedOver,
        handoff: here,
        signIn: null,
      });
      mount();
      await waitFor(() => expect(strip()).toBeInTheDocument());
      expect(within(strip()!).getByText('Your turn:').tagName).toBe('STRONG');
      // A hand leads it, hidden from screen readers so the sentence reads alone.
      expect(strip()!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    });
    it.each([
      ['the handoff ended', { ...handedOver, handoff: { ...here, outcome: 'handed-back' } }],
      ['another chat’s agent asked', { ...handedOver, handoff: { ...here, sessionId: 'x' } }],
      ['nobody asked', { ...handedOver, paused: false, handoff: null }],
    ])('shows no strip when %s', async (_case, state) => {
      transport.getLocalBrowserState.mockResolvedValue({ ...state, signIn: null });
      mount();
      // The browser was read: the header names its state.
      await waitFor(() =>
        expect(screen.getAllByRole('status')[0]).toHaveTextContent(/Agent paused|Connected/)
      );
      expect(document.querySelector('[data-slot="your-turn-strip"]')).toBeNull();
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
  describe('Close browser during a handoff', () => {
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
      await chooseFromMenu('Close browser');
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
      await chooseFromMenu('Close browser');
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
      await chooseFromMenu('Close browser');
      await waitFor(() => expect(transport.disconnectLocalBrowser).toHaveBeenCalledOnce());
      await screen.findByText(/Browser is busy|Couldn’t reach the browser/);
      expect(transport.interruptSession).not.toHaveBeenCalled();
    });
    it('interrupts nothing with no handoff open', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
      mount();
      await chooseFromMenu('Close browser');
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
    await chooseFromMenu('Close browser');
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
    const choice = mode.closest('[data-slot="local-browser-choice"]')!;
    expect(choice).not.toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }));
    expect(mode).toBeDisabled();
    // Frozen while it opens: out of reach and dimmed, not a second question (DOR-4433).
    expect(choice).toHaveAttribute('inert');
    expect(choice).toHaveClass('opacity-50');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelling…')).toBeInTheDocument();
    expect(mode).toBeDisabled();
    expect(choice).toHaveAttribute('inert');
    await act(async () => finishCancel(disconnected));
    expect(mode).toBeDisabled();
    expect(screen.getByText('Cancelling…')).toBeInTheDocument();
    await act(async () => opening.resolve(disconnected));
    await waitFor(() => expect(mode).toBeEnabled());
    expect(choice).not.toHaveAttribute('inert');
    expect(choice).not.toHaveClass('opacity-50');
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
    await chooseFromMenu('Close browser');
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    expect(screen.queryByText('Not open yet')).not.toBeInTheDocument();
  });

  it('returns keyboard focus after disconnecting the browser', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
    mount();
    await chooseFromMenu('Close browser');
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
    await chooseFromMenu('Close browser');
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
    await choosePage('Second page');
    await waitFor(() => expect(transport.selectLocalBrowserTab).toHaveBeenCalledWith('two'));
  });
  it('keeps the selected tab when another tab stops responding', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.selectLocalBrowserTab.mockRejectedValue(
      Object.assign(new Error('raw browser focus error'), { code: 'focus_unavailable' })
    );
    mount();
    await choosePage('Second page');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This tab stopped responding. Choose it again.'
    );
    const menu = await openMenu();
    expect(within(menu).getByRole('menuitemradio', { name: 'First page' })).toBeChecked();
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
    expect(
      screen.getByText('Pause stops new actions. An action already started may finish.')
    ).toBeInTheDocument();
    // The person can still go somewhere while the agent is paused.
    transport.navigateLocalBrowser.mockResolvedValue({ ...connected, paused: true });
    await typeAddress('https://new.example.com');
    await waitFor(() =>
      expect(transport.navigateLocalBrowser).toHaveBeenCalledWith('https://new.example.com')
    );
  });
  it('keeps what was typed when Enter comes while the browser is busy', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    let finish: (state: typeof connected) => void = () => {};
    transport.pauseLocalBrowser.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause agent' }));
    await typeAddress('https://new.example.com');
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('https://new.example.com');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    expect(transport.navigateLocalBrowser).not.toHaveBeenCalled();
    await act(async () => finish({ ...connected, paused: true }));
  });
  it('drops a refusal when the person picks another tab', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.selectLocalBrowserTab.mockResolvedValue({ ...connected, selectedTabId: 'two' });
    mount();
    await typeAddress('file:///etc/hosts');
    expect(await screen.findByRole('alert')).toHaveTextContent('Files don’t open here.');
    await choosePage('Second page');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('names its buttons in Radix tooltips, with no title hint (DOR-4438)', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    mount();
    const back = await screen.findByRole('button', { name: 'Back' });
    expect(back).toBeDisabled();
    expect(back).not.toHaveAttribute('title');
    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(reload).not.toHaveAttribute('title');
    fireEvent.focus(reload);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Reload');
  });
  describe('Back and Forward (DOR-4449)', () => {
    const withHistory = (canGoBack: boolean, canGoForward: boolean): LocalBrowserState => ({
      ...connected,
      tabs: connected.tabs.map((tab) =>
        tab.id === 'one' ? { ...tab, canGoBack, canGoForward } : tab
      ),
    });
    it('are enabled only where the server says the page’s history has a page', async () => {
      transport.getLocalBrowserState.mockResolvedValue(withHistory(true, false));
      mount();
      expect(await screen.findByRole('button', { name: 'Back' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
      expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    });
    it('are both disabled when the server says nothing about history', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      expect(await screen.findByRole('button', { name: 'Back' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    });
    it('move the page through the server, which answers with the new history', async () => {
      transport.getLocalBrowserState.mockResolvedValue(withHistory(true, false));
      transport.stepLocalBrowserHistory.mockResolvedValue({
        ...withHistory(false, true),
        paused: true,
      });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
      expect(transport.stepLocalBrowserHistory).toHaveBeenCalledExactlyOnceWith('back');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
      expect(transport.stepLocalBrowserHistory).toHaveBeenLastCalledWith('forward');
      expect(transport.navigateLocalBrowser).not.toHaveBeenCalled();
    });
    it('can’t be pressed twice while a step is running', async () => {
      transport.getLocalBrowserState.mockResolvedValue(withHistory(true, true));
      let finish: (state: LocalBrowserState) => void = () => {};
      transport.stepLocalBrowserHistory.mockReturnValue(
        new Promise((resolve) => (finish = resolve))
      );
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
      await act(async () => finish(withHistory(true, true)));
      expect(transport.stepLocalBrowserHistory).toHaveBeenCalledTimes(1);
    });
    it('say why a refused step stayed put on the chrome’s notice line, as for a refused address', async () => {
      transport.getLocalBrowserState.mockResolvedValue(withHistory(true, false));
      transport.stepLocalBrowserHistory.mockRejectedValue(
        Object.assign(new Error('raw redirect detail'), { code: 'history_refused' })
      );
      const { container } = mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
      const chrome = () => container.querySelector('[data-slot="browser-chrome"]') as HTMLElement;
      await waitFor(() =>
        expect(within(chrome()).getByRole('alert')).toHaveTextContent(
          'DorkOS doesn’t open that page here, so you stayed on this one.'
        )
      );
      // Said once, on the notice line, never as the panel's own error.
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.queryByText('raw redirect detail')).not.toBeInTheDocument();
      // Typing an address clears it.
      transport.navigateLocalBrowser.mockResolvedValue(withHistory(true, false));
      await typeAddress('https://example.com/next');
      await waitFor(() => expect(within(chrome()).queryByRole('alert')).toBeNull());
    });
    it('leave a real step failure to the panel, not the notice line', async () => {
      transport.getLocalBrowserState.mockResolvedValue(withHistory(true, false));
      transport.stepLocalBrowserHistory.mockRejectedValue(
        Object.assign(new Error('raw'), { code: 'navigation_uncertain' })
      );
      const { container } = mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Check what happened before continuing.'
      );
      const chrome = container.querySelector('[data-slot="browser-chrome"]') as HTMLElement;
      expect(within(chrome).queryByRole('alert')).toBeNull();
    });
  });
  it('keeps a typed address when navigation becomes stale and never replays it', async () => {
    transport.getLocalBrowserState.mockResolvedValue(connected);
    transport.navigateLocalBrowser.mockRejectedValue(
      Object.assign(new Error('changed'), { code: 'stale_page' })
    );
    mount();
    await typeAddress('https://new.example.com');
    expect(
      await screen.findByText('Page changed. Read it again before continuing.')
    ).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Address' })).toHaveValue(
      'https://new.example.com'
    );
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
      await typeAddress('https://new.example.com');
      expect(await screen.findByText('Check what happened before continuing.')).toBeInTheDocument();
      expect(await screen.findByRole('textbox', { name: 'Address' })).toHaveValue(
        'https://new.example.com'
      );
      expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
      expect(transport.navigateLocalBrowser).toHaveBeenCalledTimes(1);
    }
  );
  // DOR-4419: the address box reads what the person typed with the shared address rules.
  describe('typed addresses', () => {
    const unreachable = () =>
      Object.assign(new Error('no answer'), { code: 'navigation_unreachable' });
    const submit = typeAddress;

    it('puts https:// in front of a bare host, and http:// for a private one', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.navigateLocalBrowser.mockResolvedValue(connected);
      mount();
      await submit('example.com/docs');
      await waitFor(() =>
        expect(transport.navigateLocalBrowser).toHaveBeenCalledWith('https://example.com/docs')
      );
      await submit('192.168.1.1');
      await waitFor(() =>
        expect(transport.navigateLocalBrowser).toHaveBeenLastCalledWith('http://192.168.1.1')
      );
    });

    it('tries http:// once when a bare host it put https:// on cannot connect', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.navigateLocalBrowser
        .mockRejectedValueOnce(unreachable())
        .mockResolvedValueOnce(connected);
      mount();
      await submit('shop.example');
      await waitFor(() => expect(transport.navigateLocalBrowser).toHaveBeenCalledTimes(2));
      expect(transport.navigateLocalBrowser.mock.calls).toEqual([
        ['https://shop.example'],
        ['http://shop.example'],
      ]);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('never falls back from an address typed with https://', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.navigateLocalBrowser.mockRejectedValue(unreachable());
      mount();
      await submit('https://example.com');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t reach that site. Check the address and try again.'
      );
      expect(transport.navigateLocalBrowser).toHaveBeenCalledTimes(1);
    });

    it('never falls back after a certificate error, and tries http:// only once', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.navigateLocalBrowser.mockRejectedValueOnce(
        Object.assign(new Error('cert'), { code: 'navigation_uncertain' })
      );
      mount();
      await submit('shop.example');
      expect(await screen.findByText('Check what happened before continuing.')).toBeInTheDocument();
      expect(transport.navigateLocalBrowser).toHaveBeenCalledTimes(1);

      transport.navigateLocalBrowser.mockClear();
      transport.navigateLocalBrowser.mockRejectedValue(unreachable());
      await submit('news.example');
      await waitFor(() => expect(transport.navigateLocalBrowser).toHaveBeenCalledTimes(2));
      expect(transport.navigateLocalBrowser).toHaveBeenNthCalledWith(1, 'https://news.example');
      expect(transport.navigateLocalBrowser).toHaveBeenNthCalledWith(2, 'http://news.example');
      expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach that site.');
    });

    it.each([
      ['file:///etc/hosts', 'Files don’t open here. Ask the agent to put it on the canvas.'],
      ['javascript:alert(1)', 'Only web pages open here. Try an address starting with https://.'],
      ['http://[bad', 'That address isn’t complete. Check it and try again.'],
    ])('refuses %s with its notice and never asks the server', async (typed, notice) => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      await submit(typed);
      expect(await screen.findByRole('alert')).toHaveTextContent(notice);
      expect(transport.navigateLocalBrowser).not.toHaveBeenCalled();
      expect(await screen.findByRole('textbox', { name: 'Address' })).toHaveValue(typed);
    });

    it('refuses DorkOS’s own address', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      await submit(`${window.location.origin}/connections`);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'DorkOS doesn’t open its own pages in the Agent browser.'
      );
      expect(transport.navigateLocalBrowser).not.toHaveBeenCalled();
    });

    it('searches DuckDuckGo for words, and names it in the placeholder', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.navigateLocalBrowser.mockResolvedValue(connected);
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /^Address:/ }));
      expect(screen.getByRole('textbox', { name: 'Address' })).toHaveAttribute(
        'placeholder',
        'Search DuckDuckGo or type an address'
      );
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Address' }), { key: 'Escape' });
      await submit('best tacos');
      await waitFor(() =>
        expect(transport.navigateLocalBrowser).toHaveBeenCalledWith(
          'https://duckduckgo.com/?q=best+tacos'
        )
      );
    });
  });
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
    // A real shared Dialog: Radix never sets aria-modal, so a hand-built one proves nothing.
    const dialog = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Your preferences</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(false));
    dialog.unmount();
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
  describe('the ⋯ menu (DOR-4429)', () => {
    it('holds the page’s actions, and nothing above the page repeats them', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      const menu = await openMenu();
      const items = [...menu.querySelectorAll('[role^="menuitem"]')].map(
        (item) => item.textContent
      );
      // jsdom lays nothing out, so the row reads as narrow and Forward moves in here.
      expect(items).toEqual([
        'Forward',
        'First page',
        'Second page',
        'Copy address',
        'Open in your browser',
        'Forget saved sign-ins…',
        'Close browser',
      ]);
      // Close loses nothing saved, so it is a plain item, never a red one.
      expect(within(menu).getByRole('menuitem', { name: 'Close browser' })).not.toHaveAttribute(
        'data-variant',
        'destructive'
      );
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Forget saved sign-ins…' })).toBeNull();
    });
    it('goes forward with the row’s own Forward while the row is narrow (DOR-4449)', async () => {
      const forwardable: LocalBrowserState = {
        ...connected,
        tabs: connected.tabs.map((tab) =>
          tab.id === 'one' ? { ...tab, canGoForward: true } : tab
        ),
      };
      transport.getLocalBrowserState.mockResolvedValue(forwardable);
      transport.stepLocalBrowserHistory.mockResolvedValue(forwardable);
      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled());
      await chooseFromMenu('Forward');
      expect(transport.stepLocalBrowserHistory).toHaveBeenCalledExactlyOnceWith('forward');
      expect(transport.navigateLocalBrowser).not.toHaveBeenCalled();
    });
    it('shows Forward disabled when the page has nowhere to go forward', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      const menu = await openMenu();
      expect(within(menu).getByRole('menuitem', { name: 'Forward' })).toHaveAttribute(
        'data-disabled'
      );
    });
    it('lists Pages only when the chat has more than one', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...connected,
        tabs: [connected.tabs[0]!],
      });
      mount();
      const menu = await openMenu();
      expect(within(menu).queryByText('Pages')).toBeNull();
      expect(within(menu).queryByRole('menuitemradio')).toBeNull();
    });
    it('offers no address actions on a new empty page', async () => {
      transport.getLocalBrowserState.mockResolvedValue({
        ...connected,
        tabs: [{ id: 'one', title: '', url: 'about:blank' }],
      });
      mount();
      const menu = await openMenu();
      expect(within(menu).queryByRole('menuitem', { name: 'Copy address' })).toBeNull();
      expect(within(menu).queryByRole('menuitem', { name: 'Open in your browser' })).toBeNull();
      expect(within(menu).getByRole('menuitem', { name: 'Close browser' })).toBeInTheDocument();
    });
    it('opens the page in the person’s own browser', async () => {
      const opened = vi.spyOn(window, 'open').mockReturnValue(null);
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      await chooseFromMenu('Open in your browser');
      expect(opened).toHaveBeenCalledOnce();
      expect(opened.mock.calls[0]?.[0]).toBe('https://example.com/');
    });
    it('Forget saved sign-ins… opens today’s dialog and hands focus back to the menu', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      await chooseFromMenu('Forget saved sign-ins…');
      const dialog = await screen.findByRole('alertdialog', { name: 'Forget saved sign-ins?' });
      await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Browser menu' })).toHaveFocus()
      );
    });
    it('waits while another browser action runs', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      transport.pauseLocalBrowser.mockReturnValue(new Promise(() => {}));
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Pause agent' }));
      const menu = await openMenu();
      for (const name of ['Forget saved sign-ins…', 'Close browser'])
        expect(within(menu).getByRole('menuitem', { name })).toHaveAttribute('data-disabled');
    });
    it('hides the native page while it is open over it, and shows it again after', async () => {
      const setBounds = vi.fn().mockResolvedValue(undefined);
      window.electronAPI = { localBrowser: { setBounds } } as unknown as ElectronAPI;
      transport.getLocalBrowserState.mockResolvedValue({ ...connected, mode: 'embedded' });
      transport.getLocalBrowserCapabilities.mockResolvedValue({ ...capabilities, embedded: true });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      } as DOMRect);
      vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
        length: 1,
      } as DOMRectList);
      mount();
      await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
      await openMenu();
      await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(false));
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
    });
  });
  describe('the page area with no page (DOR-4433)', () => {
    const block = () => document.querySelector('[data-slot="local-browser-page-area-block"]');
    it('is one centred block, with the state as its only heading', async () => {
      mount();
      await screen.findByRole('button', { name: 'Open browser' });
      expect(document.querySelectorAll('[data-slot="local-browser-page-area-block"]')).toHaveLength(
        1
      );
      expect(block()).toHaveClass('items-center', 'justify-center');
      expect(block()!.firstElementChild).toHaveClass('max-w-[360px]');
      expect(within(block() as HTMLElement).getByRole('status')).toHaveTextContent('Not open yet');
      // The old stack is gone: no panel heading, no Saved sign-ins row or its hint.
      expect(screen.queryByRole('heading', { name: 'Agent browser' })).toBeNull();
      expect(screen.queryByText(/Kept apart from your own browser/)).toBeNull();
      expect(
        await screen.findByRole('button', { name: 'Forget saved sign-ins…' })
      ).toBeInTheDocument();
    });
    it('says it can’t reach the browser in one line, with Reconnect', async () => {
      transport.getLocalBrowserState.mockRejectedValue(new Error('down'));
      mount();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t reach the browser. Reconnect and try again.'
      );
      expect(
        within(block() as HTMLElement).getByRole('button', { name: 'Reconnect' })
      ).toBeEnabled();
      // Only the way back: no browser choice to make until it answers.
      expect(screen.queryByRole('button', { name: 'Open browser' })).toBeNull();
      expect(screen.queryByRole('radio')).toBeNull();
      // The alert says it; a visible "Not open yet" over it would contradict it.
      expect(screen.getAllByRole('status')[0]).toHaveClass('sr-only');
    });
    it('names another chat’s hold in the block, with no second heading', async () => {
      transport.getLocalBrowserState.mockResolvedValue({ ...connected, sessionId: 'other-chat' });
      mount();
      const take = await screen.findByRole('button', { name: 'Take it here' });
      expect(block()).toContainElement(take);
      expect(screen.getByText('This browser is open in another chat')).toBeInTheDocument();
      expect(screen.getAllByRole('status')[0]).toHaveClass('sr-only');
    });
    it('puts the own-window line in the page area', async () => {
      transport.getLocalBrowserState.mockResolvedValue(connected);
      mount();
      const line = await screen.findByText('This page is in the separate browser window.');
      expect(line.closest('[data-slot="local-browser-page-area-block"]')).not.toBeNull();
    });
    it('on a new empty page, keeps the native page hidden and says what to do', async () => {
      const setBounds = vi.fn().mockResolvedValue(undefined);
      window.electronAPI = { localBrowser: { setBounds } } as unknown as ElectronAPI;
      const empty = {
        ...connected,
        mode: 'embedded' as const,
        tabs: [{ id: 'one', title: '', url: 'about:blank' }],
      };
      transport.getLocalBrowserState.mockResolvedValue(empty);
      transport.getLocalBrowserCapabilities.mockResolvedValue({ ...capabilities, embedded: true });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
      } as DOMRect);
      const view = mount();
      expect(await screen.findByText('Type an address or a search above.')).toBeInTheDocument();
      expect(setBounds.mock.calls.every(([bounds]) => !bounds.visible)).toBe(true);
      // Once a page loads, the native page shows and the line goes.
      act(() =>
        view.client.setQueryData(['local-browser', 'state'], {
          ...empty,
          tabs: [{ id: 'one', title: 'Fares', url: 'https://northwind.example/fares' }],
        })
      );
      await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
      expect(screen.queryByText('Type an address or a search above.')).toBeNull();
    });
  });
});
