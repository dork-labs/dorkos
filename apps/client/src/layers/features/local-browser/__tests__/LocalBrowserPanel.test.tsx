// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalBrowserCapabilities, LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserPanel } from '../ui/LocalBrowserPanel';
import { useAppStore } from '@/layers/shared/model';

const transport = vi.hoisted(() => ({
  getLocalBrowserState: vi.fn(),
  getLocalBrowserCapabilities: vi.fn(),
  openLocalBrowser: vi.fn(),
  pauseLocalBrowser: vi.fn(),
  resumeLocalBrowser: vi.fn(),
  disconnectLocalBrowser: vi.fn(),
  selectLocalBrowserTab: vi.fn(),
  navigateLocalBrowser: vi.fn(),
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
}));
const disconnected: LocalBrowserState = {
  connectionId: null,
  sessionId: null,
  browserVersion: null,
  channel: null,
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
  existing: true,
  defaultMode: 'new-window',
  platform: 'darwin',
  managedChromiumVersion: '153.0.8010.12',
  existingBrowserVersions: { minimum: 144, maximum: 155 },
  unavailableReasons: {},
  playwrightVersion: '1.63.0',
  existingSetup: [
    {
      channel: 'chrome',
      name: 'Chrome',
      address: 'chrome://inspect/#remote-debugging',
      steps: ['Open Chrome.', 'Allow DorkOS to use this browser.'],
    },
  ],
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
function mount(visible = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LocalBrowserPanel visible={visible} sessionId="chat-one" agentName="Kai" />
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
});
afterEach(() => {
  delete window.electronAPI;
  vi.restoreAllMocks();
});

describe('LocalBrowserPanel', () => {
  it('never labels another chat’s browser with the current agent name', async () => {
    transport.getLocalBrowserState.mockResolvedValue({ ...connected, sessionId: 'other-chat' });
    mount();
    expect(await screen.findByLabelText('Shared with another chat')).toBeInTheDocument();
    expect(screen.queryByLabelText('Shared with Kai')).not.toBeInTheDocument();
  });
  it.each(['Cancel', 'Disconnect'])(
    'returns %s keyboard focus to the required fresh consent',
    async (action) => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      useAppStore.getState().setLocalBrowserChoice({ mode: 'existing', channel: 'chrome' });
      transport.disconnectLocalBrowser.mockResolvedValue(disconnected);
      const opening = holdOpening();
      if (action === 'Disconnect') {
        transport.getLocalBrowserState.mockResolvedValue({
          ...connected,
          mode: 'existing',
          channel: 'chrome',
        });
      }
      mount();
      if (action === 'Cancel') {
        const consent = await screen.findByRole('checkbox', {
          name: 'Allow DorkOS to use this browser',
        });
        fireEvent.click(consent);
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Connect browser' })).toBeEnabled()
        );
        fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }));
      }
      const button = await screen.findByRole('button', { name: action });
      button.focus();
      fireEvent.click(button);
      if (action === 'Cancel') await act(async () => opening.resolve(disconnected));
      const consent = await screen.findByRole('checkbox', {
        name: 'Allow DorkOS to use this browser',
      });
      await waitFor(() => expect(consent).toHaveFocus());
      expect(consent).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Connect browser' })).toBeDisabled();
      fireEvent.click(consent);
      expect(consent).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Connect browser' })).toBeEnabled();
    }
  );
  it.each([
    ['chrome', 'Google Chrome'],
    ['msedge', 'Microsoft Edge'],
  ] as const)('names the connected %s browser and the current agent', async (channel, name) => {
    transport.getLocalBrowserState.mockResolvedValue({ ...connected, mode: 'existing', channel });
    mount();
    expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
    expect(await screen.findByLabelText('Shared with Kai')).toHaveValue('one');
  });
  it('remembers browser choice through disconnect/remount but requires fresh consent and tab choice', async () => {
    const personal = {
      ...connected,
      mode: 'existing' as const,
      channel: 'msedge' as const,
      selectedTabId: null,
    };
    transport.openLocalBrowser.mockImplementation(async () => {
      transport.getLocalBrowserState.mockResolvedValue(personal);
      return personal;
    });
    transport.selectLocalBrowserTab.mockImplementation(async (id: string) => {
      const next = { ...personal, selectedTabId: id };
      transport.getLocalBrowserState.mockResolvedValue(next);
      return next;
    });
    transport.disconnectLocalBrowser.mockImplementation(async () => {
      transport.getLocalBrowserState.mockResolvedValue(disconnected);
      return disconnected;
    });
    const first = mount();
    const mode = await screen.findByRole('radio', { name: /Your existing browser/ });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.click(mode);
    fireEvent.change(screen.getByLabelText('Choose your browser'), { target: { value: 'msedge' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }));
    const tabs = await screen.findByLabelText('Shared with Kai');
    expect(tabs).toHaveValue('');
    fireEvent.change(tabs, { target: { value: 'two' } });
    await waitFor(() => expect(tabs).toHaveValue('two'));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const connect = await screen.findByRole('button', { name: 'Connect browser' });
    expect(connect).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' })
    ).not.toBeChecked();
    expect(screen.getByLabelText('Choose your browser')).toHaveValue('msedge');
    first.unmount();
    mount();
    expect(await screen.findByRole('radio', { name: /Your existing browser/ })).toBeChecked();
    expect(await screen.findByLabelText('Choose your browser')).toHaveValue('msedge');
    expect(
      screen.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' })
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect browser' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }));
    expect(await screen.findByLabelText('Shared with Kai')).toHaveValue('');
    expect(useAppStore.getState().localBrowserChoice).toEqual({
      mode: 'existing',
      channel: 'msedge',
    });
  });
  it('keeps an unsupported saved mode instead of silently switching browsers', async () => {
    useAppStore.getState().setLocalBrowserChoice({ mode: 'embedded', channel: 'chrome' });
    mount();
    expect(await screen.findByRole('radio', { name: /DorkOS browser/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /New browser window/ })).not.toBeChecked();
    expect(screen.getByText('Requires the DorkOS desktop app.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open browser' })).toBeDisabled();
    expect(transport.openLocalBrowser).not.toHaveBeenCalled();
  });
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
    const choice = screen.getByRole('radio', { name: /New browser window/ });
    await waitFor(() => expect(choice).toBeEnabled());
    fireEvent.click(choice);
    expect(screen.getByRole('button', { name: 'Open browser' })).toBeEnabled();
    expect(useAppStore.getState().localBrowserChoice).toEqual({
      mode: 'new-window',
      channel: 'chrome',
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
  it('freezes personal browser choice and consent until cancellation completes', async () => {
    const opening = holdOpening();
    let finishCancel!: (state: LocalBrowserState) => void;
    transport.disconnectLocalBrowser.mockReturnValue(
      new Promise<LocalBrowserState>((resolve) => {
        finishCancel = resolve;
      })
    );
    mount();
    const mode = await screen.findByRole('radio', { name: /Your existing browser/ });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.click(mode);
    const browser = screen.getByLabelText('Choose your browser');
    const consent = screen.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' });
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }));
    expect(browser).toBeDisabled();
    expect(consent).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelling…')).toBeInTheDocument();
    expect(browser).toBeDisabled();
    expect(consent).toBeDisabled();
    await act(async () => finishCancel(disconnected));
    expect(browser).toBeDisabled();
    expect(screen.getByText('Cancelling…')).toBeInTheDocument();
    await act(async () => opening.resolve(disconnected));
    await waitFor(() => expect(browser).toBeEnabled());
    expect(consent).toBeEnabled();
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
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
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
  it('offers exactly three modes and defaults web to a separate browser window', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Open browser' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /DorkOS browser/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /New browser window/ })).toBeChecked();
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
  it('requires consent for the selected personal browser and selects its exact tab', async () => {
    mount();
    const radio = await screen.findByRole('radio', { name: /Your existing browser/ });
    await waitFor(() => expect(radio).toBeEnabled());
    fireEvent.click(radio);
    expect(screen.getByRole('button', { name: 'Connect browser' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Choose your browser'), { target: { value: 'msedge' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }));
    await waitFor(() =>
      expect(transport.openLocalBrowser).toHaveBeenCalledWith({
        mode: 'existing',
        sessionId: 'chat-one',
        channel: 'msedge',
        consent: true,
      })
    );
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
    const radio = await screen.findByRole('radio', { name: /DorkOS browser/ });
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
    expect(
      await screen.findByText('Shared with another chat. Disconnect to use it here.')
    ).toBeInTheDocument();
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(false));
  });
  it('explains an unsupported browser version without exposing technical errors', async () => {
    transport.openLocalBrowser.mockRejectedValue(
      Object.assign(new Error('Update your browser, then connect it again.'), {
        code: 'unsupported_version',
      })
    );
    mount();
    const radio = await screen.findByRole('radio', { name: /Your existing browser/ });
    await waitFor(() => expect(radio).toBeEnabled());
    fireEvent.click(radio);
    expect(screen.getByRole('textbox', { name: 'Browser setup address' })).toHaveValue(
      'chrome://inspect/#remote-debugging'
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow DorkOS to use this browser' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }));
    expect(
      await screen.findByText('Update your browser, then connect it again.')
    ).toBeInTheDocument();
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
