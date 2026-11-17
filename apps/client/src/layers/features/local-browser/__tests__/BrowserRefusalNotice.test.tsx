// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalBrowserCapabilities, LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserPanel } from '../ui/LocalBrowserPanel';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';

const transport = vi.hoisted(() => ({
  getLocalBrowserState: vi.fn(),
  getLocalBrowserCapabilities: vi.fn(),
  openLocalBrowser: vi.fn(),
  navigateLocalBrowser: vi.fn(),
  takeOverLocalBrowser: vi.fn(),
  stepLocalBrowserHistory: vi.fn(),
  signInLocalBrowser: vi.fn(),
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

// DOR-4097: a site that refuses the in-app browser. The notice sits on the chrome's
// notice line, in a neutral tone, with the page left visible.
const rejected = { kind: 'sign-in' as const, host: 'accounts.example.com' };
const refusedTab = (url: string) => ({
  ...embedded,
  tabs: [{ id: 'one', title: 'Sign in', url }],
});

describe('a site that refuses the in-app browser (DOR-4097)', () => {
  it('names the site, keeps the page showing, and opens the sign-in window on it', async () => {
    transport.getLocalBrowserState.mockResolvedValue(
      refusedTab('https://accounts.example.com/signin/rejected?x=1')
    );
    transport.signInLocalBrowser.mockResolvedValue(embedded);
    await mountOpen();
    emit({ refusal: rejected });
    const words = await screen.findByText('example.com won’t let you sign in here.');
    const notice = words.closest('[data-slot="browser-refusal-notice"]')!;
    expect(notice).toHaveAttribute('role', 'status');
    // Neutral, never the error line's red glyph.
    expect(notice.querySelector('.text-destructive')).toBeNull();
    expect(setBounds.mock.calls.at(-1)?.[0].visible).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in window' }));
    await waitFor(() =>
      expect(transport.signInLocalBrowser).toHaveBeenCalledExactlyOnceWith({
        url: 'https://accounts.example.com',
      })
    );
  });

  it('says a blocked site won’t open here, with the same way out', async () => {
    transport.getLocalBrowserState.mockResolvedValue(refusedTab('https://shop.northwind.example/'));
    transport.signInLocalBrowser.mockResolvedValue(embedded);
    await mountOpen();
    emit({ refusal: { kind: 'blocked', host: 'shop.northwind.example' } });
    expect(await screen.findByText('northwind.example won’t open here.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open in its own window' }));
    await waitFor(() =>
      expect(transport.signInLocalBrowser).toHaveBeenCalledExactlyOnceWith({
        url: 'https://shop.northwind.example',
      })
    );
  });

  it('replaces any other notice on that line', async () => {
    transport.getLocalBrowserState.mockResolvedValue(
      refusedTab('https://accounts.example.com/signin/rejected?x=1')
    );
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const field = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(field, { target: { value: 'file:///etc/hosts' } });
    fireEvent.submit(field.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Files don’t open here.');
    emit({ refusal: rejected });
    expect(await screen.findByText('example.com won’t let you sign in here.')).toBeVisible();
    expect(screen.queryByText('Files don’t open here.')).toBeNull();
  });

  it('stays dismissed on the same page, and comes back on the next refused page', async () => {
    const first = 'https://accounts.example.com/signin/rejected?x=1';
    transport.getLocalBrowserState.mockResolvedValue(refusedTab(first));
    await mountOpen();
    emit({ refusal: rejected });
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('example.com won’t let you sign in here.')).toBeNull();
    // A reload of the same page reports the same refusal again.
    emit({ refusal: rejected, loading: true });
    emit({ refusal: rejected });
    expect(screen.queryByText('example.com won’t let you sign in here.')).toBeNull();
    transport.getLocalBrowserState.mockResolvedValue(
      refusedTab('https://accounts.example.com/signin/rejected?x=2')
    );
    // The next poll brings the next page.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });
    emit({ refusal: rejected });
    expect(await screen.findByText('example.com won’t let you sign in here.')).toBeVisible();
  });

  it('gives way to a real load failure, which keeps its block', async () => {
    await mountOpen();
    emit({
      refusal: rejected,
      failure: {
        code: 'ERR_NAME_NOT_RESOLVED',
        host: 'accounts.example.com',
        url: 'https://accounts.example.com/x',
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Can’t find accounts.example.com');
    expect(screen.queryByText(/won’t let you sign in here/)).toBeNull();
  });

  it('wraps on a phone with the button below, at a 44px target, never cutting the site', async () => {
    transport.getLocalBrowserState.mockResolvedValue(
      refusedTab('https://accounts.example.com/signin/rejected?x=1')
    );
    await mountOpen();
    emit({ refusal: rejected });
    const notice = await screen.findByText('example.com won’t let you sign in here.');
    expect(notice.className).not.toMatch(/truncate|line-clamp/);
    expect(notice.parentElement?.className).toMatch(/flex-wrap/);
    expect(screen.getByRole('button', { name: 'Open sign-in window' }).className).toMatch(
      /min-h-11/
    );
  });

  it('after the sign-in saves, offers its own window and waits for the click', async () => {
    const url = 'https://accounts.example.com/signin/rejected?x=1';
    transport.getLocalBrowserState.mockResolvedValue({
      ...refusedTab(url),
      handoff: null,
      takenOver: false,
      signIn: {
        profileId: null,
        site: 'accounts.example.com',
        status: 'saved',
        startedAt: '2026-11-17T20:00:00.000Z',
      },
    });
    transport.openLocalBrowser.mockResolvedValue({ ...embedded, mode: 'new-window' });
    await mountOpen();
    emit({ refusal: rejected });
    expect(
      await screen.findByText('Signed in to example.com. It works in its own window, not here.')
    ).toBeVisible();
    expect(transport.openLocalBrowser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open in its own window' }));
    await waitFor(() =>
      expect(transport.openLocalBrowser).toHaveBeenCalledExactlyOnceWith({
        mode: 'new-window',
        sessionId: 'chat-one',
        url,
      })
    );
  });
});
