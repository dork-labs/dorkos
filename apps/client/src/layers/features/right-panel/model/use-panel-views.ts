import { useEffect, useMemo, useState } from 'react';
import { FileText, Globe, SquareTerminal } from 'lucide-react';
import { useComputer } from '@/layers/entities/computer';
import { useRoom } from '@/layers/entities/room';
import { useSessionId } from '@/layers/entities/session';
import { useLocalBrowserState } from '@/layers/entities/local-browser';
import { toast } from 'sonner';
import type { AuthorRef } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { links } from '@dorkos/shared/links';
import {
  documentPanelScope,
  legacyDocumentPanelScope,
  documentsInView,
  roomDocumentsInView,
  useAppStore,
  useTerminalResourceChrome,
  useTransport,
  type RightPanelContribution,
  type PanelViewPreference,
  type PanelViewPreferences,
} from '@/layers/shared/model';
import type { TabActivationSource } from '@/layers/shared/ui';

const DEFAULTS = new Set(['agent-profile', 'profile', 'files', 'room', 'computer']);
const OPTIONAL = new Set(['pulse', 'session', 'canvas', 'browser', 'local-browser', 'terminal']);
const EMPTY_PREFERENCES: PanelViewPreferences = {};
/** One concrete view presented by the shared panel row. */
export interface PanelView extends RightPanelContribution {
  category: string;
  resource?: 'document' | 'terminal' | 'browser';
  closed?: boolean;
  activate?: (source: TabActivationSource) => void;
  author?: AuthorRef;
  watchers?: AuthorRef[];
  unread?: boolean;
  pinned?: boolean;
  /** Cannot be closed: the chat's own agent profile in a 1:1 chat (FB-60). */
  permanent?: boolean;
}

/** Relevant defaults and concrete resource tabs, preserving the existing route and placement gates. */
export function usePanelViews(contributions: RightPanelContribution[], pathname: string) {
  const activeCategory = useAppStore((s) => s.activeRightPanelTab);
  const setCategory = useAppStore((s) => s.setActiveRightPanelTab);
  const layoutKey = useAppStore((s) => s.rightPanelLayoutKey);
  const cwd = useAppStore((s) => s.selectedCwd);
  const explicitAgentPath = useAppStore((s) => s.explicitAgentPath);
  const sessionId = useAppStore((s) => s.sessionId);
  const [routeSessionId] = useSessionId();
  const directSessionId = pathname === '/session' ? routeSessionId : null;
  const browserScope = directSessionId ? `chat/${encodeURIComponent(directSessionId)}` : 'human';
  const { data: localBrowser } = useLocalBrowserState(
    contributions.some((view) => view.id === 'local-browser')
  );
  const browserConnection =
    localBrowser?.status === 'connected' &&
    localBrowser.connectionId &&
    localBrowser.sessionId === directSessionId
      ? localBrowser
      : null;
  const localBrowserViewId = browserConnection
    ? `resource/browser/${browserScope}/${encodeURIComponent(browserConnection.connectionId!)}`
    : 'local-browser';
  const roomId = useAppStore((s) => s.roomCanvasLiveRoomId);
  const sessionDocuments = useAppStore((s) => s.openDocuments);
  const roomDocuments = useAppStore((s) => (roomId ? s.roomCanvasDocuments[roomId] : undefined));
  const unread = useAppStore((s) => (roomId ? s.roomCanvasUnread[roomId] : undefined));
  const presence = useAppStore((s) => (roomId ? s.roomCanvasPresence[roomId] : undefined));
  const room = useRoom(roomId);
  const transport = useTransport();
  const canvasId = useAppStore((s) =>
    roomId ? s.roomCanvasActive[roomId]?.canvas : s.activeCanvasDocumentId
  );
  const browserId = useAppStore((s) =>
    roomId ? s.roomCanvasActive[roomId]?.browser : s.activeBrowserDocumentId
  );
  const activateSession = useAppStore((s) => s.activateCanvasDocument);
  const activateRoom = useAppStore((s) => s.activateRoomCanvasDocument);
  const chrome = useTerminalResourceChrome((s) => s.chrome);
  const terminalScope = `${sessionId ?? ''}:${cwd}`;
  const terminal = chrome?.scope === terminalScope ? chrome : null;
  const [terminalIntent, setTerminalIntent] = useState<{ scope: string; id: string | null } | null>(
    null
  );
  useEffect(() => {
    if (terminalIntent?.scope !== terminalScope || !terminal) return;
    const published = terminalIntent.id
      ? terminal.tabs.find((tab) => `resource/terminal/${tab.id}` === terminalIntent.id)
      : terminal.tabs.find((tab) => tab.id === terminal.activeId);
    if (published && !published.closed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Drop the optimistic selection once its owner publishes it.
      setTerminalIntent(null);
    }
  }, [terminal, terminalIntent, terminalScope]);
  const computer = useComputer();
  const key = roomId ? `room:${roomId}` : (explicitAgentPath ?? layoutKey ?? cwd ?? pathname);
  const canvasSessionId = useAppStore((s) => s.canvasSessionId);
  const canvasSessionCwd = useAppStore((s) => s.canvasSessionCwd);
  const ownerSession =
    canvasSessionCwd !== undefined ? canvasSessionId : (canvasSessionId ?? sessionId);
  const ownerCwd = canvasSessionCwd !== undefined ? canvasSessionCwd : cwd;
  const resourceScope = roomId ? `room:${roomId}` : documentPanelScope(ownerSession, ownerCwd);
  const legacyScope = roomId ? `room:${roomId}` : legacyDocumentPanelScope(ownerSession, ownerCwd);
  const preferences = useAppStore((s) => s.panelViewPreferences) ?? EMPTY_PREFERENCES;
  const updatePreference = useAppStore((s) => s.updatePanelViewPreference);
  const reopenResource = useAppStore((s) => s.reopenPanelResourceView);
  const ownerClosures = useMemo(
    () => new Set(Object.values(preferences).flatMap((entry) => entry.closed)),
    [preferences]
  );
  const preference = preferences[key] ?? { opened: [], closed: [] };
  const computerRelevant =
    computer.data?.cwd != null &&
    (explicitAgentPath
      ? computer.data.cwd.replace(/\/workspace\/?$/, '') === explicitAgentPath
      : computer.data.cwd === cwd) &&
    computer.data.phase !== 'disabled' &&
    computer.data.phase !== 'unsupported';
  const available = useMemo(
    () => contributions.filter((c) => c.id !== 'computer' || computerRelevant),
    [contributions, computerRelevant]
  );

  const save = (update: (entry: PanelViewPreference) => PanelViewPreference) =>
    updatePreference?.(key, update);
  const isBrowser = (id: string) => allViews.find((view) => view.id === id)?.resource === 'browser';
  const closedKey = (id: string) =>
    isBrowser(id)
      ? id
      : allViews.find((view) => view.id === id)?.resource
        ? `${resourceScope}:${id}`
        : id;
  const closedKeys = (id: string) =>
    allViews.find((view) => view.id === id)?.resource === 'document'
      ? [closedKey(id), `${legacyScope}:${id}`]
      : [closedKey(id)];
  const isDocument = (id: string) =>
    allViews.find((view) => view.id === id)?.resource === 'document';
  // In a 1:1 chat the profile is the agent you are talking to. It is the
  // panel's answer to "who is this", so it stays, and a close saved somewhere
  // else does not hide it here (FB-60).
  const isPermanent = (id: string) => id === 'profile' && pathname === '/session';
  const viewClosed = (id: string) =>
    !isPermanent(id) &&
    closedKeys(id).some((closedId) =>
      isDocument(id) || isBrowser(id)
        ? ownerClosures.has(closedId)
        : preference.closed.includes(closedId)
    );
  const allViews: PanelView[] = available.flatMap((contribution): PanelView[] => {
    const category = contribution.id;
    if (category === 'local-browser') {
      if (!browserConnection) return [{ ...contribution, category, title: 'Browser' }];
      const selected = browserConnection.tabs.find(
        (tab) => tab.id === browserConnection.selectedTabId
      );
      const browserName =
        browserConnection.mode === 'embedded' ? 'DorkOS browser' : 'New browser window';
      return [
        {
          ...contribution,
          category,
          resource: 'browser',
          id: localBrowserViewId,
          title: selected?.title || browserName,
          icon: Globe,
        },
      ];
    }
    if (category === 'browser' || category === 'canvas') {
      const documents = roomId
        ? roomDocumentsInView(roomDocuments ?? [], category)
        : documentsInView(sessionDocuments ?? [], category);
      if (documents.length)
        return documents.map((doc) => ({
          ...contribution,
          category,
          resource: 'document',
          id: `resource/${doc.id}`,
          title:
            ('title' in doc ? doc.title || doc.sourceLabel : doc.sourceLabel) || contribution.title,
          icon: category === 'browser' ? Globe : FileText,
          activate: () => {
            if (roomId) activateRoom(roomId, doc.id);
            else activateSession(doc.id);
          },
          ...('authorId' in doc
            ? {
                author: room.data?.members.find((member) => member.author.id === doc.authorId)
                  ?.author,
                unread: unread?.[category]?.includes(doc.id),
                pinned: doc.pinned,
                watchers: Object.entries(presence ?? {})
                  .filter(
                    ([authorId, documentId]) =>
                      documentId === doc.id && authorId !== room.data?.viewerAuthorId
                  )
                  .flatMap(
                    ([authorId]) =>
                      room.data?.members.find((member) => member.author.id === authorId)?.author ??
                      []
                  ),
              }
            : {}),
        }));
    }
    if (category === 'terminal' && terminal?.tabs.length)
      return terminal.tabs.map((tab) => ({
        ...contribution,
        category,
        resource: 'terminal',
        id: `resource/terminal/${tab.id}`,
        title: tab.title,
        closed: tab.closed,
        icon: SquareTerminal,
        activate: (source) => terminal.activate(tab.id, source),
      }));
    return [
      {
        ...contribution,
        category,
        ...(category === 'browser' ? { title: 'Page previews' } : {}),
        ...(isPermanent(category) ? { permanent: true } : {}),
      },
    ];
  });
  // A stream may publish the server row before POST identifies it. Defer only possible
  // echoes of a closed unresolved open; existing twins and explicit selections stay visible.
  const deferredDocuments = new Set<string>();
  if (!roomId) {
    const pending = (sessionDocuments ?? []).filter(
      (doc) => doc.id.startsWith('pending:') && viewClosed(`resource/${doc.id}`)
    );
    for (const doc of sessionDocuments ?? []) {
      if (doc.id.startsWith('pending:') || doc.openedHere) continue;
      if (pending.some((open) => open.pendingCandidateIds?.includes(doc.id)))
        deferredDocuments.add(`resource/${doc.id}`);
    }
  }

  const contextual = allViews.some(
    (view) => DEFAULTS.has(view.category) || (!OPTIONAL.has(view.category) && !view.isGlobal)
  );
  const visible = allViews.filter(
    (view) =>
      (!view.closed ||
        (terminalIntent?.scope === terminalScope && terminalIntent.id === view.id)) &&
      !viewClosed(view.id) &&
      !deferredDocuments.has(view.id) &&
      (DEFAULTS.has(view.category) ||
        !OPTIONAL.has(view.category) ||
        view.resource ||
        view.extensionId ||
        preference.opened.includes(view.category) ||
        view.category === activeCategory ||
        (!contextual && view.isGlobal && view.category !== 'local-browser'))
  );
  // Keep a new-shell request visible until its owner publishes the newly created tab.
  if (
    activeCategory === 'terminal' &&
    terminalIntent?.scope === terminalScope &&
    terminalIntent.id === null &&
    !visible.some((view) => view.category === 'terminal')
  ) {
    const contribution = available.find((view) => view.id === 'terminal');
    if (contribution) visible.push({ ...contribution, category: 'terminal' });
  }
  const selectedResourceId =
    activeCategory === 'terminal'
      ? `resource/terminal/${terminal?.activeId}`
      : activeCategory === 'local-browser'
        ? localBrowserViewId
        : activeCategory === 'browser'
          ? `resource/${browserId}`
          : activeCategory === 'canvas'
            ? `resource/${canvasId}`
            : activeCategory;
  const activeId =
    visible.find((v) => v.id === selectedResourceId)?.id ??
    visible.find((v) => v.category === activeCategory)?.id ??
    null;
  const selectedDocument = roomId
    ? roomDocuments?.find((doc) => `resource/${doc.id}` === selectedResourceId)
    : sessionDocuments?.find((doc) => `resource/${doc.id}` === selectedResourceId);
  const selectedVersion = selectedDocument
    ? `${selectedDocument.rev}:${selectedDocument.lastActiveAt}`
    : null;
  const requested = useAppStore((s) => s.requestedRightPanel);
  const activate = (id: string, source: TabActivationSource = 'pointer') => {
    const view = allViews.find((v) => v.id === id);
    if (!view) return;
    save((entry) => ({
      opened: [...new Set([...entry.opened, view.category])].slice(-100),
      closed: entry.closed.filter((v) => !closedKeys(id).includes(v)),
    }));
    if (view.resource === 'document' || view.resource === 'browser')
      reopenResource?.(closedKeys(id));
    setTerminalIntent(view.resource === 'terminal' ? { scope: terminalScope, id: view.id } : null);
    view.activate?.(source);
    setCategory(view.category);
  };
  const closeView = (id: string) => {
    if (isPermanent(id)) return;
    const closingPending = sessionDocuments?.find(
      (doc) => doc.id.startsWith('pending:') && `resource/${doc.id}` === id
    );
    // Closing a pending view must not automatically select its still-unidentified echo.
    const neighbors = closingPending
      ? visible.filter(
          (view) =>
            !closingPending.pendingCandidateIds?.some(
              (candidateId) =>
                `resource/${candidateId}` === view.id &&
                !sessionDocuments?.find((doc) => doc.id === candidateId)?.openedHere
            )
        )
      : visible;
    const neighbor =
      neighbors[neighbors.findIndex((v) => v.id === id) + 1] ??
      neighbors[neighbors.findIndex((v) => v.id === id) - 1];
    const view = allViews.find((view) => view.id === id);
    setTerminalIntent(null);
    if (view?.resource === 'terminal' && terminal?.hide) {
      terminal.hide(id.slice('resource/terminal/'.length));
    } else {
      const update = (entry: PanelViewPreference) => ({
        ...entry,
        closed: [...new Set([...entry.closed, closedKey(id)])].slice(-100),
      });
      if (view?.resource === 'document') updatePreference?.(`documents:${resourceScope}`, update);
      else if (view?.resource === 'browser') updatePreference?.(`browsers:${browserScope}`, update);
      else save(update);
    }
    if (id === activeId) {
      neighbor?.activate?.('keyboard');
      setCategory(neighbor?.category ?? null);
    }
  };

  // External open commands and restored layouts are view requests, so they reopen the target.
  useEffect(() => {
    if (!activeCategory) return;
    const resourceKeys = selectedResourceId ? closedKeys(selectedResourceId) : [];
    if (
      !preference.closed.includes(activeCategory) &&
      (!selectedResourceId || !viewClosed(selectedResourceId))
    )
      return;
    save((entry) => ({
      ...entry,
      closed: entry.closed.filter((id) => id !== activeCategory && !resourceKeys.includes(id)),
    }));
    if (selectedResourceId && (isDocument(selectedResourceId) || isBrowser(selectedResourceId)))
      reopenResource?.(resourceKeys);
    // Only a new category request, not a local close, reopens a view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeCategory,
    selectedResourceId,
    selectedVersion,
    requested,
    resourceScope,
    browserScope,
    key,
  ]);

  const activeDocumentId =
    activeCategory === 'browser' ? browserId : activeCategory === 'canvas' ? canvasId : null;
  const activeDocument = roomId
    ? roomDocuments?.find((doc) => doc.id === activeDocumentId)
    : sessionDocuments?.find((doc) => doc.id === activeDocumentId);
  const attempt = async (run: () => void | Promise<unknown>) => {
    try {
      await run();
    } catch {
      toast.error('Couldn’t update the canvas.');
    }
  };
  const createDocument = (content: UiCanvasContent) => {
    void attempt(() =>
      roomId
        ? transport.openRoomCanvasDocument(roomId, content)
        : useAppStore.getState().openCanvasDocument(content)
    );
    setCategory(content.type === 'url' ? 'browser' : 'canvas');
  };
  return {
    available,
    allViews,
    visible,
    activeId,
    activate,
    closeView,
    terminal,
    createTerminal: available.some((view) => view.id === 'terminal')
      ? () => {
          setTerminalIntent({ scope: terminalScope, id: null });
          save((entry) => ({
            opened: [...new Set([...entry.opened, 'terminal'])].slice(-100),
            closed: entry.closed.filter((id) => id !== 'terminal'),
          }));
          if (terminal) terminal.create();
          else useTerminalResourceChrome.getState().requestCreate(terminalScope);
          setCategory('terminal');
        }
      : undefined,
    createBrowser: available.some((c) => c.id === 'browser')
      ? () => createDocument({ type: 'url', url: links.site, title: 'Web Page' })
      : undefined,
    createDocument: available.some((c) => c.id === 'canvas')
      ? () =>
          createDocument({
            type: 'markdown',
            content: '# Untitled\n\nStart writing…',
            title: 'Document',
          })
      : undefined,
    removeDocument: activeDocument
      ? () =>
          void attempt(() =>
            roomId
              ? transport.closeRoomCanvasDocument(roomId, activeDocument.id)
              : useAppStore.getState().closeCanvasDocument(activeDocument.id)
          )
      : undefined,
    pinDocument:
      roomId && activeDocument
        ? () =>
            void attempt(() =>
              transport.updateRoomCanvasDocument(roomId, activeDocument.id, {
                pinned: !activeDocument.pinned,
              })
            )
        : undefined,
    documentPinned: activeDocument?.pinned ?? false,
  };
}
