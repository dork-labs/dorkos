import { vi, type Mock } from 'vitest';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalBrowserCapabilities, LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserPanel } from '../ui/LocalBrowserPanel';
import { useAppStore } from '@/layers/shared/model';

const transport: {
  getLocalBrowserState: Mock;
  getLocalBrowserCapabilities: Mock;
  openLocalBrowser: Mock;
  pauseLocalBrowser: Mock;
  resumeLocalBrowser: Mock;
  disconnectLocalBrowser: Mock;
  closeIdleLocalBrowserTab: Mock;
  selectLocalBrowserTab: Mock;
  navigateLocalBrowser: Mock;
  interruptSession: Mock;
  signInLocalBrowser: Mock;
} = vi.hoisted(() => ({
  getLocalBrowserState: vi.fn(),
  getLocalBrowserCapabilities: vi.fn(),
  openLocalBrowser: vi.fn(),
  pauseLocalBrowser: vi.fn(),
  resumeLocalBrowser: vi.fn(),
  disconnectLocalBrowser: vi.fn(),
  closeIdleLocalBrowserTab: vi.fn(),
  selectLocalBrowserTab: vi.fn(),
  navigateLocalBrowser: vi.fn(),
  interruptSession: vi.fn(),
  signInLocalBrowser: vi.fn(),
}));
const navigate: Mock = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
}));
export const disconnected: LocalBrowserState = {
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
export const connected: LocalBrowserState = {
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
export const capabilities: LocalBrowserCapabilities = {
  embedded: false,
  newWindow: true,
  defaultMode: 'new-window',
  platform: 'darwin',
  managedChromiumVersion: '157.0.8103.15',
  unavailableReasons: {},
  playwrightVersion: '1.65.0-alpha-2026-10-30',
};
export function holdOpening() {
  let resolve!: (state: LocalBrowserState) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<LocalBrowserState>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  transport.openLocalBrowser.mockReturnValue(promise);
  return { resolve, reject };
}
export function mount(
  visible = true,
  sessionId: string | null = 'chat-one'
): RenderResult & { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LocalBrowserPanel visible={visible} sessionId={sessionId} agentName="Kai" />
    </QueryClientProvider>
  );
  return { ...view, client };
}
export function resetBrowserPanelFixture() {
  vi.resetAllMocks();
  delete window.electronAPI;
  localStorage.clear();
  useAppStore.setState({ localBrowserChoice: null, localBrowserChoiceIssue: null });
  transport.getLocalBrowserState.mockResolvedValue(disconnected);
  transport.getLocalBrowserCapabilities.mockResolvedValue(capabilities);
  transport.openLocalBrowser.mockResolvedValue(connected);
}

export { transport, navigate };
