// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import {
  useAppStore,
  useTerminalResourceChrome,
  type CanvasDocument,
  type RightPanelContribution,
} from '@/layers/shared/model';
import { usePanelViews } from '../model/use-panel-views';
import { setSessionCanvasTransport } from '@/layers/shared/model/app-store/app-store-canvas';
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => ({}),
}));

const routeSession = vi.hoisted(() => ({ id: 'one' as string | null }));
vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [routeSession.id, vi.fn()],
}));

const localBrowser = vi.hoisted(() => ({ data: undefined as LocalBrowserState | undefined }));
vi.mock('@/layers/entities/local-browser', () => ({ useLocalBrowserState: () => localBrowser }));
const computer = vi.hoisted(() => ({
  data: { id: 'local', cwd: '/agents/computer/workspace', phase: 'ready' },
}));
vi.mock('@/layers/entities/room', () => ({ useRoom: () => ({ data: undefined }) }));
vi.mock('@/layers/entities/computer', () => ({ useComputer: () => computer }));
const contributions = [
  'pulse',
  'profile',
  'session',
  'files',
  'computer',
  'canvas',
  'browser',
  'local-browser',
  'terminal',
].map((id) => ({
  id,
  title: id,
  component: () => null,
  isGlobal: id === 'pulse',
})) satisfies RightPanelContribution[];
function document(id: string): CanvasDocument {
  return {
    id,
    content: { type: 'url', url: 'https://example.com', title: `Page ${id}` },
    sourceLabel: `Page ${id}`,
    rev: 1,
    openedAt: 1,
    lastActiveAt: 1,
    pinned: false,
    openedHere: false,
    editing: false,
    heldUpdate: null,
  };
}
beforeEach(() => {
  routeSession.id = 'one';
  localBrowser.data = undefined;
  localStorage.clear();
  useTerminalResourceChrome.setState({ chrome: null, createRequest: null });
  useAppStore.setState({
    activeRightPanelTab: 'profile',
    rightPanelLayoutKey: 'agent:one',
    selectedCwd: '/agents/one/workspace',
    explicitAgentPath: '/agents/one',
    sessionId: 'one',
    canvasSessionId: null,
    canvasSessionCwd: undefined,
    panelViewPreferences: {},
    roomCanvasLiveRoomId: null,
    openDocuments: [],
    activeBrowserDocumentId: null,
    activeCanvasDocumentId: null,
  });
});
afterEach(() => {
  cleanup();
  setSessionCanvasTransport(null);
});

function deferredDocument() {
  let resolve!: (row: ServerCanvasDocument) => void;
  const promise = new Promise<ServerCanvasDocument>((done) => {
    resolve = done;
  });
  const transport = createMockTransport({ openSessionCanvasDocument: vi.fn(() => promise) });
  setSessionCanvasTransport(transport);
  return { transport, resolve };
}

function serverDocument(id: string, scope = 'session:one'): ServerCanvasDocument {
  return {
    id,
    scope,
    roomId: null,
    content: { type: 'markdown', content: 'draft', title: 'Draft' },
    contentType: 'markdown',
    title: 'Draft',
    authorId: 'owner',
    pinned: false,
    rev: 1,
    lastTouchedBy: 'owner',
    lastTouchedAt: '2026-10-14T12:00:00Z',
    openedAt: '2026-10-14T12:00:00Z',
    lastActiveAt: '2026-10-14T12:00:00Z',
  };
}

function liveBrowser(
  connectionId = 'connection-one',
  sessionId: string | null = 'one'
): LocalBrowserState {
  return {
    connectionId,
    sessionId,
    mode: 'new-window',
    status: 'connected',
    paused: false,
    selectedTabId: 'chosen',
    revision: 1,
    preparation: null,
    tabs: [{ id: 'chosen', title: 'Signed-in report', url: 'https://example.com/report' }],
  };
}

describe('relevant panel views', () => {
  // Purpose: an app's openCanvas from its own page opens a tab beside it
  // (designer, DOR-3293), and that page's panel holds only what the app opened.
  it('shows on an app’s page only the documents that app opened', () => {
    const markdown = (id: string, openedBy?: string): CanvasDocument => ({
      ...document(id),
      content: { type: 'markdown', content: id, title: id },
      sourceLabel: id,
      ...(openedBy ? { openedBy: { extensionId: openedBy } } : {}),
    });
    useAppStore.setState({
      openDocuments: [
        markdown('chat-notes'),
        markdown('summary', 'ledger'),
        markdown('desk', 'desk'),
      ],
    });
    const { result } = renderHook(() => usePanelViews(contributions, '/x/ledger'));
    const canvasTabs = result.current.allViews.filter((view) => view.category === 'canvas');
    expect(canvasTabs.map((view) => view.title)).toEqual(['summary']);
  });
  it.each([null, 'stale-legacy'])(
    'scopes a connected Browser to the route chat when legacy session is %s',
    (legacySessionId) => {
      routeSession.id = 'current';
      useAppStore.setState({ sessionId: legacySessionId });
      localBrowser.data = liveBrowser('connection-current', 'current');
      const { result } = renderHook(() => usePanelViews(contributions, '/session'));
      expect(
        result.current.allViews.find((view) => view.category === 'local-browser')
      ).toMatchObject({
        id: 'resource/browser/chat/current/connection-current',
        resource: 'browser',
        title: 'Signed-in report',
      });
    }
  );
  it.each(['embedded', 'new-window'] as const)(
    'names an untitled %s page the Agent browser, never by how it opens (DOR-3219)',
    (mode) => {
      routeSession.id = 'current';
      localBrowser.data = {
        ...liveBrowser('connection-current', 'current'),
        mode,
        selectedTabId: null,
        tabs: [],
      };
      const { result } = renderHook(() => usePanelViews(contributions, '/session'));
      expect(result.current.allViews.find((view) => view.category === 'local-browser')?.title).toBe(
        'Agent browser'
      );
    }
  );

  it('never exposes a legacy chat connection when the route has no chat', () => {
    routeSession.id = null;
    localBrowser.data = liveBrowser('legacy-connection', 'one');
    const { result, rerender } = renderHook(() => usePanelViews(contributions, '/session'));
    expect(result.current.allViews.find((view) => view.category === 'local-browser')).toMatchObject(
      {
        id: 'local-browser',
        title: 'Browser',
      }
    );
    localBrowser.data = liveBrowser('human-connection', null);
    rerender();
    expect(result.current.allViews.find((view) => view.category === 'local-browser')?.id).toBe(
      'resource/browser/human/human-connection'
    );
  });
  it('uses a fresh browser resource for a new connection and never a retained canvas owner', () => {
    localBrowser.data = liveBrowser();
    useAppStore.setState({
      canvasSessionId: 'retained-canvas',
      canvasSessionCwd: '/agents/retained',
    });
    const { result, rerender } = renderHook(() => usePanelViews(contributions, '/session'));
    const first = 'resource/browser/chat/one/connection-one';
    act(() => result.current.closeView(first));
    expect(useAppStore.getState().panelViewPreferences['browsers:chat/one'].closed).toContain(
      first
    );
    expect(
      Object.keys(useAppStore.getState().panelViewPreferences).some((key) =>
        key.startsWith('documents:')
      )
    ).toBe(false);
    localBrowser.data = liveBrowser('connection-two');
    rerender();
    expect(
      result.current.visible.some((view) => view.id === 'resource/browser/chat/one/connection-two')
    ).toBe(true);
    act(() => {
      localBrowser.data = liveBrowser('connection-three', 'two');
      routeSession.id = 'two';
    });
    rerender();
    const secondChat = 'resource/browser/chat/two/connection-three';
    act(() => result.current.closeView(secondChat));
    const preferences = useAppStore.getState().panelViewPreferences;
    expect(preferences['browsers:chat/two'].closed).toContain(secondChat);
    expect(preferences['browsers:chat/one'].closed).toContain(first);
    expect(preferences['browsers:chat/one'].closed).not.toContain(secondChat);
  });
  it.each(['/team', '/rooms/room-one'])(
    'keeps human browsing separate from the remembered chat on %s and hides foreign live titles',
    (pathname) => {
      localBrowser.data = liveBrowser('human-connection', null);
      const { result, rerender } = renderHook(() => usePanelViews(contributions, pathname));
      expect(result.current.allViews.find((view) => view.category === 'local-browser')?.id).toBe(
        'resource/browser/human/human-connection'
      );
      localBrowser.data = liveBrowser('foreign-connection', 'one');
      rerender();
      expect(
        result.current.allViews.find((view) => view.category === 'local-browser')
      ).toMatchObject({ id: 'local-browser', title: 'Browser' });
      expect(result.current.allViews.some((view) => view.title === 'Signed-in report')).toBe(false);
    }
  );
  it('keeps the original keyed-open receipt when a second write sharing its pending ID is refused', async () => {
    const { resolve, transport } = deferredDocument();
    useAppStore.getState().loadCanvasForSession('one');
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    const content = { type: 'markdown' as const, content: 'draft', sourcePath: 'src/a.ts' };
    act(() => useAppStore.getState().openCanvasDocument(content));
    const id = useAppStore.getState().openDocuments[0].id;
    vi.mocked(transport.openSessionCanvasDocument).mockRejectedValueOnce(
      new Error('second write refused')
    );
    await act(async () =>
      useAppStore.getState().openCanvasDocument({ ...content, content: 'second' })
    );
    expect(useAppStore.getState().openDocuments).toHaveLength(1);
    act(() => result.current.closeView(`resource/${id}`));
    act(() => {
      useAppStore.getState().loadCanvasForSession('two');
      useAppStore.getState().setSessionId('two');
      useAppStore.getState().carryCanvasWritesAcross('one', 'canonical');
    });
    await act(async () => resolve({ ...serverDocument('actual-new'), content }));
    expect(useAppStore.getState().openDocuments).toEqual([]);
    act(() => {
      useAppStore.getState().loadCanvasForSession('canonical');
      useAppStore.getState().setSessionId('canonical');
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot('canonical', [
          { ...serverDocument('actual-new', 'session:canonical'), content },
        ]);
    });
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource/actual-new');
  });

  it('keeps receipt ownership through a held 404 retry and disposes a genuinely canceled held write', async () => {
    const { resolve, transport } = deferredDocument();
    vi.mocked(transport.openSessionCanvasDocument).mockRejectedValueOnce({
      code: 'SESSION_NOT_FOUND',
    });
    useAppStore.getState().loadCanvasForSession('one');
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    await act(async () =>
      useAppStore.getState().openCanvasDocument(serverDocument('actual-new').content)
    );
    const pendingId = useAppStore.getState().openDocuments[0].id;
    act(() => result.current.closeView(`resource/${pendingId}`));
    await act(async () => {
      useAppStore.getState().carryCanvasWritesAcross('one', 'canonical');
      useAppStore.getState().hydrateCanvasFromSnapshot('canonical', []);
    });
    expect(transport.openSessionCanvasDocument).toHaveBeenCalledTimes(2);
    act(() => {
      useAppStore.getState().loadCanvasForSession('two');
      useAppStore.getState().setSessionId('two');
    });
    await act(async () => resolve(serverDocument('actual-new')));
    act(() => {
      useAppStore.getState().loadCanvasForSession('canonical');
      useAppStore.getState().setSessionId('canonical');
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot('canonical', [
          serverDocument('actual-new', 'session:canonical'),
        ]);
    });
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource/actual-new');

    vi.mocked(transport.openSessionCanvasDocument).mockRejectedValueOnce({
      code: 'SESSION_NOT_FOUND',
    });
    useAppStore.getState().loadCanvasForSession('canceled');
    await act(async () =>
      useAppStore.getState().openCanvasDocument(serverDocument('never-created').content)
    );
    const attempts = vi.mocked(transport.openSessionCanvasDocument).mock.calls.length;
    act(() => useAppStore.getState().loadCanvasForSession('other'));
    await act(async () => {
      useAppStore.getState().loadCanvasForSession('canceled');
      useAppStore.getState().hydrateCanvasFromSnapshot('canceled', []);
    });
    expect(transport.openSessionCanvasDocument).toHaveBeenCalledTimes(attempts);
    expect(useAppStore.getState().openDocuments).toEqual([]);
  });

  it('retains a live pinned echo candidate through a burst of identical twins and prunes replaced snapshot rows', async () => {
    const { resolve } = deferredDocument();
    useAppStore.getState().loadCanvasForSession('one');
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    act(() => useAppStore.getState().openCanvasDocument(serverDocument('actual-new').content));
    const pendingId = useAppStore.getState().openDocuments[0].id;
    act(() => result.current.closeView(`resource/${pendingId}`));
    act(() =>
      useAppStore.getState().applyCanvasEvent('one', {
        documentId: 'actual-new',
        document: { ...serverDocument('actual-new'), pinned: true },
        change: 'opened',
      })
    );
    const changed = {
      ...serverDocument('actual-new'),
      pinned: true,
      rev: 2,
      content: {
        type: 'markdown' as const,
        content: 'Changed after initial echo',
        title: 'Changed',
      },
    };
    act(() =>
      useAppStore
        .getState()
        .applyCanvasEvent('one', { documentId: 'actual-new', document: changed, change: 'updated' })
    );
    for (let index = 0; index < 16; index++)
      act(() =>
        useAppStore.getState().applyCanvasEvent('one', {
          documentId: `twin-${index}`,
          document: serverDocument(`twin-${index}`),
          change: 'opened',
        })
      );
    expect(useAppStore.getState().openDocuments.some((doc) => doc.id === 'actual-new')).toBe(true);
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource/actual-new');
    let candidates = useAppStore
      .getState()
      .openDocuments.find((doc) => doc.id === pendingId)!.pendingCandidateIds!;
    expect(candidates).toContain('actual-new');
    expect(
      candidates.every((id) => useAppStore.getState().openDocuments.some((doc) => doc.id === id))
    ).toBe(true);
    act(() => useAppStore.getState().hydrateCanvasFromSnapshot('one', [changed]));
    candidates = useAppStore
      .getState()
      .openDocuments.find((doc) => doc.id === pendingId)!.pendingCandidateIds!;
    expect(candidates).toEqual(['actual-new']);
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource/actual-new');
    await act(async () => resolve(serverDocument('actual-new')));
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource/actual-new');
  });

  it('shows one tab, not two, when the pending view is reopened after its echo arrived', async () => {
    const { resolve } = deferredDocument();
    useAppStore.getState().loadCanvasForSession('one');
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    act(() => useAppStore.getState().openCanvasDocument(serverDocument('actual-new').content));
    const pendingId = useAppStore.getState().openDocuments[0].id;
    act(() => result.current.closeView(`resource/${pendingId}`));
    act(() =>
      useAppStore.getState().applyCanvasEvent('one', {
        documentId: 'actual-new',
        document: serverDocument('actual-new'),
        change: 'opened',
      })
    );
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource/actual-new');
    act(() => result.current.activate(`resource/${pendingId}`));
    const before = result.current.visible.map((view) => view.id);
    expect(before).toContain(`resource/${pendingId}`);
    expect(before).not.toContain('resource/actual-new');
    await act(async () => resolve(serverDocument('actual-new')));
    const after = result.current.visible.map((view) => view.id);
    expect(after).toContain('resource/actual-new');
    expect(after).not.toContain(`resource/${pendingId}`);
    expect(result.current.activeId).toBe('resource/actual-new');
  });

  it('never shows an open document twice while its echo arrives before the POST answers', async () => {
    const { resolve } = deferredDocument();
    useAppStore.getState().loadCanvasForSession('one');
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    act(() => useAppStore.getState().openCanvasDocument(serverDocument('actual-new').content));
    const pendingId = useAppStore.getState().openDocuments[0].id;
    act(() =>
      useAppStore.getState().applyCanvasEvent('one', {
        documentId: 'actual-new',
        document: serverDocument('actual-new'),
        change: 'opened',
      })
    );
    const before = result.current.visible.map((view) => view.id);
    expect(before).toContain(`resource/${pendingId}`);
    expect(before).not.toContain('resource/actual-new');
    await act(async () => resolve(serverDocument('actual-new')));
    const after = result.current.visible.map((view) => view.id);
    expect(after).toContain('resource/actual-new');
    expect(after).not.toContain(`resource/${pendingId}`);
  });
  it('keeps mini-app identities separate from concrete resources across chats', () => {
    const miniApp = {
      id: 'resource:page',
      title: 'Mini app',
      component: () => null,
      extensionId: 'resource',
    };
    useAppStore.setState({ openDocuments: [document('page')] });
    const { result } = renderHook(() => usePanelViews([...contributions, miniApp], '/session'));
    expect(result.current.allViews.map((view) => view.id)).toEqual(
      expect.arrayContaining(['resource:page', 'resource/page'])
    );
    act(() => result.current.activate('resource:page'));
    expect(result.current.activeId).toBe('resource:page');
    act(() => result.current.closeView('resource:page'));
    act(() => useAppStore.setState({ sessionId: 'another-chat' }));
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource:page');
    expect(result.current.visible.map((view) => view.id)).toContain('resource/page');
  });
  it('never closes the chat agent’s profile in a 1:1 chat, even over a close saved elsewhere (FB-60)', () => {
    const onlyProfile = contributions.filter((view) => view.id === 'profile');
    const offChat = renderHook(() => usePanelViews(onlyProfile, '/team'));
    act(() => offChat.result.current.closeView('profile'));
    expect(offChat.result.current.visible).toHaveLength(0);
    offChat.unmount();
    useAppStore.setState({ activeRightPanelTab: 'profile' });
    const inChat = renderHook(() => usePanelViews(onlyProfile, '/session'));
    expect(inChat.result.current.visible.map((v) => v.id)).toEqual(['profile']);
    expect(inChat.result.current.visible[0]?.permanent).toBe(true);
    act(() => inChat.result.current.closeView('profile'));
    expect(inChat.result.current.visible.map((v) => v.id)).toEqual(['profile']);
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
  });
  // Categories are discoverable through + without consuming tab space in every chat.
  it('starts with Profile and Files and shows Computer only for its bound agent', () => {
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    expect(result.current.visible.map((v) => v.id)).toEqual(['profile', 'files']);
    expect(result.current.allViews.map((v) => v.id)).toContain('browser');
    expect(result.current.allViews.map((v) => v.id)).not.toContain('computer');
    act(() =>
      useAppStore.setState({
        selectedCwd: computer.data.cwd,
        explicitAgentPath: '/agents/computer',
      })
    );
    expect(result.current.visible.map((v) => v.id)).toContain('computer');
  });

  // One agent's optional views and closed resources must never leak into another agent's layout.
  it('restores optional views by agent while scoping closed resource identities to the session', () => {
    const { result, unmount } = renderHook(() => usePanelViews(contributions, '/session'));
    act(() => result.current.activate('session'));
    act(() =>
      useAppStore.setState({
        rightPanelLayoutKey: 'agent:two',
        explicitAgentPath: '/agents/two',
        activeRightPanelTab: 'profile',
      })
    );
    expect(result.current.visible.map((v) => v.id)).not.toContain('session');
    unmount();
    useAppStore.setState({ rightPanelLayoutKey: 'agent:one', explicitAgentPath: '/agents/one' });
    const restored = renderHook(() => usePanelViews(contributions, '/session'));
    expect(restored.result.current.visible.map((v) => v.id)).toContain('session');
  });

  // Header actions operate on the mounted shell owner; close view never calls its explicit Stop action.
  it('uses PTY identity and keeps closing a shell separate from stopping it', () => {
    const activate = vi.fn();
    const stop = vi.fn();
    useTerminalResourceChrome.setState({
      chrome: {
        scope: 'one:/agents/one/workspace',
        tabs: [{ id: 'pty-1', title: 'Shell 1' }],
        activeId: 'pty-1',
        activate,
        stop,
        create: vi.fn(),
      },
    });
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    act(() => result.current.activate('resource/terminal/pty-1', 'keyboard'));
    expect(activate).toHaveBeenCalledWith('pty-1', 'keyboard');
    act(() => result.current.closeView('resource/terminal/pty-1'));
    expect(stop).not.toHaveBeenCalled();
    expect(result.current.allViews.map((v) => v.id)).toContain('resource/terminal/pty-1');
  });

  it('keeps a closed pending shell hidden when its PTY identity resolves', () => {
    const hide = vi.fn((id: string) => {
      const chrome = useTerminalResourceChrome.getState().chrome!;
      useTerminalResourceChrome.setState({
        chrome: { ...chrome, activeId: null, tabs: [{ id, title: 'Shell 1', closed: true }] },
      });
    });
    const activate = vi.fn((id: string) => {
      const chrome = useTerminalResourceChrome.getState().chrome!;
      useTerminalResourceChrome.setState({
        chrome: { ...chrome, activeId: id, tabs: [{ id, title: 'Shell 1', closed: false }] },
      });
    });
    const stop = vi.fn();
    useTerminalResourceChrome.setState({
      chrome: {
        scope: 'one:/agents/one/workspace',
        tabs: [{ id: 't1', title: 'Shell 1' }],
        activeId: 't1',
        activate,
        hide,
        stop,
        create: vi.fn(),
      },
    });
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    act(() => result.current.activate('resource/terminal/t1'));
    act(() => result.current.closeView('resource/terminal/t1'));
    expect(hide).toHaveBeenCalledWith('t1');
    act(() => {
      const chrome = useTerminalResourceChrome.getState().chrome!;
      useTerminalResourceChrome.setState({
        chrome: { ...chrome, tabs: [{ id: 'pty-live', title: 'Shell 1', closed: true }] },
      });
    });
    expect(result.current.visible.some((view) => view.category === 'terminal')).toBe(false);
    expect(result.current.allViews.some((view) => view.id === 'resource/terminal/pty-live')).toBe(
      true
    );
    act(() => result.current.activate('resource/terminal/pty-live'));
    expect(result.current.activeId).toBe('resource/terminal/pty-live');
    expect(stop).not.toHaveBeenCalled();
  });

  // Explicit inspector selection outranks the ambient chat folder, so another agent cannot inherit this computer.
  it('does not expose the computer under another explicitly selected agent', () => {
    useAppStore.setState({ selectedCwd: computer.data.cwd, explicitAgentPath: '/agents/other' });
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    expect(result.current.allViews.map((view) => view.id)).not.toContain('computer');
  });

  // A new command selecting the same server row must reopen its view and keep header/body identity aligned.
  it('reopens a closed concrete page when an external activation requests it again', () => {
    useAppStore.setState({ openDocuments: [document('page')], activeBrowserDocumentId: 'page' });
    const { result } = renderHook(() => usePanelViews(contributions, '/session'));
    act(() => result.current.activate('resource/page'));
    act(() => result.current.closeView('resource/page'));
    expect(result.current.visible.map((view) => view.id)).not.toContain('resource/page');
    act(() => {
      useAppStore.getState().activateCanvasDocument('page');
      useAppStore.getState().setActiveRightPanelTab('browser');
    });
    expect(result.current.activeId).toBe('resource/page');
  });
});
