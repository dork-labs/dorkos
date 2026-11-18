// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalBrowserCapabilities, LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserPanel } from '../ui/LocalBrowserPanel';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';

// DOR-4430 (page errors) and DOR-4431 (loading bar), driven through the panel with a fake
// desktop bridge. Every host and address here is made up.
const transport = vi.hoisted(() => ({
  getLocalBrowserState: vi.fn(),
  getLocalBrowserCapabilities: vi.fn(),
  openLocalBrowser: vi.fn(),
  navigateLocalBrowser: vi.fn(),
  takeOverLocalBrowser: vi.fn(),
  stepLocalBrowserHistory: vi.fn(),
  getSession: vi.fn(),
  getAgentByPath: vi.fn(),
}));

const embedded: LocalBrowserState = {
  connectionId: 'owned',
  sessionId: 'chat-one',
  mode: 'embedded',
  status: 'connected',
  paused: false,
  tabs: [{ id: 'one', title: 'Pricing', url: 'https://example.com/' }],
  selectedTabId: 'one',
  revision: 0,
  preparation: null,
};
const capabilities: LocalBrowserCapabilities = {
  embedded: true,
  newWindow: true,
  defaultMode: 'embedded',
  platform: 'darwin',
  managedChromiumVersion: '157.0.8103.15',
  unavailableReasons: {},
  playwrightVersion: '1.65.0-alpha-2026-10-30',
};

type Listener = (state: DesktopBrowserPageState) => void;
let listeners: Listener[] = [];
let setBounds: ReturnType<typeof vi.fn>;
let page: ReturnType<typeof vi.fn>;

function emit(state: Partial<DesktopBrowserPageState>) {
  act(() => {
    for (const listener of listeners)
      listener({ connectionId: 'owned', loading: false, failure: null, ...state });
  });
}

const failure = (code: string, host = 'northwind.example') => ({
  code,
  host,
  url: `https://${host}/pricing`,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport as unknown as Transport}>
        <LocalBrowserPanel visible sessionId="chat-one" agentName="Kai" />
      </TransportProvider>
    </QueryClientProvider>
  );
}

async function mountOpen() {
  mount();
  await screen.findByRole('button', { name: /^Address:/ });
  await waitFor(() => expect(page).toHaveBeenCalledWith('owned', 'read'));
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useAppStore.setState({ localBrowserChoice: null, localBrowserChoiceIssue: null });
  listeners = [];
  setBounds = vi.fn().mockResolvedValue(undefined);
  page = vi.fn().mockResolvedValue(null);
  window.electronAPI = {
    localBrowser: {
      setBounds,
      page,
      onPageChange: (listener: Listener) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((other) => other !== listener);
        };
      },
    },
  } as unknown as ElectronAPI;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  transport.getLocalBrowserState.mockResolvedValue(embedded);
  transport.getLocalBrowserCapabilities.mockResolvedValue(capabilities);
  transport.navigateLocalBrowser.mockResolvedValue(embedded);
  transport.getAgentByPath.mockResolvedValue(null);
});
afterEach(() => {
  delete window.electronAPI;
  vi.restoreAllMocks();
});

describe('page errors DorkOS draws in the page area (DOR-4430)', () => {
  it('names the host, hides the native page and keeps the failed address in the field', async () => {
    await mountOpen();
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
    emit({ failure: failure('ERR_NAME_NOT_RESOLVED') });
    const block = await screen.findByRole('alert');
    expect(block).toHaveTextContent('Can’t find northwind.example');
    expect(block).toHaveTextContent('Check the spelling. If it’s right, the site may be down.');
    expect(
      screen.getByRole('button', { name: 'Address: northwind.example/pricing' })
    ).toBeInTheDocument();
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(false));
    // An agent's address is never searched for.
    expect(screen.queryByRole('button', { name: 'Search for it' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(page).toHaveBeenCalledWith('owned', 'retry');
  });

  it('offers to search only for what the person typed, in their own words', async () => {
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const field = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(field, { target: { value: 'https://northwind.example/' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() =>
      expect(transport.navigateLocalBrowser).toHaveBeenCalledWith('https://northwind.example/')
    );
    emit({ failure: failure('ERR_NAME_NOT_RESOLVED') });
    fireEvent.click(await screen.findByRole('button', { name: 'Search for it' }));
    await waitFor(() =>
      expect(transport.navigateLocalBrowser).toHaveBeenLastCalledWith(
        'https://duckduckgo.com/?q=https%3A%2F%2Fnorthwind.example%2F'
      )
    );
  });

  it.each([
    [
      'ERR_CONNECTION_REFUSED',
      'northwind.example didn’t respond',
      'The site may be down or busy. Try again in a moment.',
      'Try again',
    ],
    [
      'ERR_INTERNET_DISCONNECTED',
      'You’re offline',
      'Check your internet connection, then try again.',
      'Try again',
    ],
    [
      'ERR_CERT_AUTHORITY_INVALID',
      'This connection isn’t private',
      'northwind.example’s certificate isn’t valid, so DorkOS stopped loading it.',
      'Go back',
    ],
    [
      'ERR_BLOCKED_BY_CLIENT',
      'DorkOS doesn’t open this page',
      'The Agent browser keeps pages like this closed.',
      'Go back',
    ],
    [
      'ERR_BLOCKED_BY_ADMINISTRATOR',
      'northwind.example is blocked',
      'Your network or computer won’t let this browser open it.',
      'Go back',
    ],
    [
      'ERR_TOO_MANY_REDIRECTS',
      'northwind.example redirects too many times',
      'Forgetting saved sign-ins for every site may fix it.',
      'Try again',
    ],
    ['CRASHED', 'This page stopped working', 'Reload it to start it again.', 'Reload'],
  ])('%s: one title, one line, one button', async (code, title, line, primary) => {
    await mountOpen();
    emit({ failure: failure(code) });
    const block = await screen.findByRole('alert');
    expect(block).toHaveTextContent(title);
    expect(block).toHaveTextContent(line);
    const buttons = block.querySelectorAll('button');
    expect([...buttons].map((button) => button.textContent)).toEqual([primary]);
  });

  it('a certificate error has no way through, and Go back goes back', async () => {
    transport.getLocalBrowserState.mockResolvedValue({
      ...embedded,
      tabs: [{ ...embedded.tabs[0]!, canGoBack: true, canGoForward: false }],
    });
    transport.stepLocalBrowserHistory.mockResolvedValue(embedded);
    await mountOpen();
    emit({ failure: failure('ERR_CERT_DATE_INVALID') });
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /proceed|continue|anyway/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    // The same guarded step as the chrome's Back (DOR-4449), never the host's own goBack.
    await waitFor(() => expect(transport.stepLocalBrowserHistory).toHaveBeenCalledWith('back'));
    expect(page).not.toHaveBeenCalledWith('owned', 'back');
  });

  it('with no allowed page behind, Go back opens an empty page', async () => {
    await mountOpen();
    emit({ failure: failure('ERR_CERT_DATE_INVALID') });
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(transport.navigateLocalBrowser).toHaveBeenCalledWith('about:blank'));
    expect(transport.stepLocalBrowserHistory).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalledWith('owned', 'back');
  });

  it('a page that commits takes the block away and shows the page again', async () => {
    await mountOpen();
    emit({ failure: failure('ERR_CONNECTION_RESET') });
    await screen.findByRole('alert');
    emit({ failure: null });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
  });

  it('a cancelled load shows nothing', async () => {
    await mountOpen();
    emit({ failure: failure('ERR_ABORTED') });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a page another connection reported', async () => {
    await mountOpen();
    act(() => {
      for (const listener of listeners)
        listener({
          connectionId: 'someone-else',
          loading: true,
          failure: failure('ERR_NAME_NOT_RESOLVED'),
        });
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[data-slot="browser-loading-bar"]')).toBeNull();
  });
});

// DOR-4427: a tooltip over the native page waits for a still, and never blanks it.
describe('the chrome tooltips over the embedded page', () => {
  it('keeps the page and a plain hint on a desktop shell that takes no stills', async () => {
    await mountOpen();
    await waitFor(() => expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true));
    setBounds.mockClear();
    const reload = screen.getByRole('button', { name: 'Reload' });
    fireEvent.focus(reload);
    await waitFor(() => expect(reload).toHaveAttribute('title', 'Reload'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(setBounds).not.toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
  });
});

describe('the loading bar (DOR-4431)', () => {
  it('runs in the seam while loading, turns Reload into Stop and marks the row busy', async () => {
    await mountOpen();
    const form = document.querySelector('[data-slot="browser-chrome-row"]')!;
    expect(form).toHaveAttribute('aria-busy', 'false');
    expect(document.querySelector('[data-slot="browser-loading-bar"]')).toBeNull();
    emit({ loading: true });
    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelector('[data-slot="browser-loading-bar"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(page).toHaveBeenCalledWith('owned', 'stop');
    emit({ loading: false });
    expect(form).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('Stop while the agent drives also takes the page, in one step (DOR-4428)', async () => {
    transport.takeOverLocalBrowser.mockResolvedValue({
      ...embedded,
      paused: true,
      handoff: null,
      signIn: null,
      takenOver: true,
    });
    await mountOpen();
    emit({ loading: true });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(page).toHaveBeenCalledWith('owned', 'stop');
    await waitFor(() => expect(transport.takeOverLocalBrowser).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(document.querySelector('[data-slot="browser-status-pill"]')).toHaveAttribute(
        'data-state-kind',
        'you'
      )
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Stop takes nothing when no chat shares the page', async () => {
    transport.getLocalBrowserState.mockResolvedValue({ ...embedded, sessionId: null });
    await mountOpen();
    emit({ loading: true });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(page).toHaveBeenCalledWith('owned', 'stop');
    expect(transport.takeOverLocalBrowser).not.toHaveBeenCalled();
  });

  it('picks up a load that started before the panel opened', async () => {
    page.mockResolvedValue({ connectionId: 'owned', loading: true, failure: null });
    mount();
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('stays idle on a desktop shell without the page bridge', async () => {
    window.electronAPI = { localBrowser: { setBounds } } as unknown as ElectronAPI;
    mount();
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
