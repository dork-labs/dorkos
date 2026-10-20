import type { StateCreator } from 'zustand';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import type { AppState } from './app-store-types';
import type { CanvasDocument } from './app-store-canvas';
import { isPendingId } from './canvas-document-candidates';
import {
  documentPanelScope,
  legacyDocumentPanelScope,
  remapClosedPanelDocument,
  remapClosedPanelScope,
  remapClosedPanelSession,
  reopenPanelResourcePreferences,
  writePanelViewPreferences,
} from '../panel-resources/preferences';

type CanvasSet = Parameters<StateCreator<AppState, [['zustand/devtools', never]]>>[0];
interface DocumentViewDependencies {
  set: CanvasSet;
  get: () => AppState;
  fromServer: (row: ServerCanvasDocument, previous?: CanvasDocument) => CanvasDocument;
  renameBrowserHistory: (
    histories: AppState['browserHistories'],
    pendingId: string,
    actualId: string
  ) => AppState['browserHistories'];
}

interface OpenReceipt {
  pendingId: string;
  originalSessionId: string;
  sessionId: string;
  cwd: string | null;
  selectedIds: Set<string>;
}

/** Local view identity follows outstanding writes independently of the visible canvas owner. */
export function createCanvasDocumentViews({
  set,
  get,
  fromServer,
  renameBrowserHistory,
}: DocumentViewDependencies) {
  // Receipt identity survives navigation only while its POST/held retry is outstanding.
  const openReceipts = new Set<OpenReceipt>();
  /**
   * Replace a pending row with the row the server answered with.
   *
   * Matched on the pending id this window minted rather than on the source key:
   * `json` and `widget` have no key, and two of them opened in the same tick
   * would otherwise adopt each other's rows.
   */
  function settlePending(
    pendingId: string,
    row: ServerCanvasDocument,
    receipt?: OpenReceipt
  ): void {
    set((s) => {
      const previous = s.openDocuments.find((d) => d.id === pendingId);
      if (!previous && !receipt) return {};
      const capturedSession = receipt?.sessionId ?? s.canvasSessionId;
      const ownerCwd = receipt
        ? receipt.cwd
        : s.canvasSessionCwd !== undefined
          ? s.canvasSessionCwd
          : s.selectedCwd;
      // A local rekey wins over an older receipt; otherwise the server may name the canonical owner.
      const rowSession = row.scope.startsWith('session:')
        ? row.scope.slice('session:'.length)
        : capturedSession;
      const ownerSession =
        receipt && receipt.sessionId !== receipt.originalSessionId ? receipt.sessionId : rowSession;
      let panelViewPreferences =
        capturedSession !== ownerSession && capturedSession !== null && ownerSession !== null
          ? remapClosedPanelSession(s.panelViewPreferences, capturedSession, ownerSession, [
              ownerCwd,
            ])
          : s.panelViewPreferences;
      const scopes = [
        documentPanelScope(ownerSession, ownerCwd),
        legacyDocumentPanelScope(ownerSession, ownerCwd),
      ];
      const visibleOwner =
        s.canvasSessionId === capturedSession &&
        (s.canvasSessionCwd !== undefined ? s.canvasSessionCwd : s.selectedCwd) === ownerCwd;
      const already = visibleOwner
        ? s.openDocuments.find((d) => d.id === row.id && d.id !== pendingId)
        : undefined;
      // Exact explicit selections survive departure; never infer ownership from content.
      panelViewPreferences =
        already?.openedHere || receipt?.selectedIds.has(row.id)
          ? reopenPanelResourcePreferences(
              panelViewPreferences,
              scopes.map((scope) => `${scope}:resource/${pendingId}`)
            )
          : remapClosedPanelDocument(panelViewPreferences, scopes, pendingId, row.id);
      writePanelViewPreferences(panelViewPreferences);
      if (!previous || !visibleOwner) return { panelViewPreferences };
      const documents = already
        ? s.openDocuments.filter((d) => d.id !== pendingId)
        : s.openDocuments.map((d) => (d.id === pendingId ? fromServer(row, previous) : d));
      const swapId = (id: string | null) => (id === pendingId ? row.id : id);
      return {
        panelViewPreferences,
        openDocuments: documents,
        canvasSessionId: ownerSession,
        activeCanvasDocumentId: swapId(s.activeCanvasDocumentId),
        activeBrowserDocumentId: swapId(s.activeBrowserDocumentId),
        browserHistories: renameBrowserHistory(s.browserHistories, pendingId, row.id),
      };
    });
  }

  function beginOpen(
    pendingId: string,
    sessionId: string | null,
    cwd: string | null,
    connected: boolean,
    fresh: boolean
  ): OpenReceipt | undefined {
    const receipt =
      sessionId !== null && connected
        ? {
            pendingId,
            originalSessionId: sessionId,
            sessionId,
            cwd,
            selectedIds: new Set<string>(),
          }
        : undefined;
    if (receipt && fresh) openReceipts.add(receipt);
    return receipt;
  }
  function finish(receipt: OpenReceipt) {
    openReceipts.delete(receipt);
  }
  function captureSelection(id: string, before: AppState) {
    if (!isPendingId(id)) {
      const ownerCwd =
        before.canvasSessionCwd !== undefined ? before.canvasSessionCwd : before.selectedCwd;
      const retained = new Set(
        before.openDocuments.filter((doc) => !isPendingId(doc.id)).map((doc) => doc.id)
      );
      for (const receipt of openReceipts)
        if (receipt.sessionId === before.canvasSessionId && receipt.cwd === ownerCwd) {
          receipt.selectedIds = new Set(
            [...receipt.selectedIds].filter((selected) => retained.has(selected))
          );
          receipt.selectedIds.add(id);
        }
    }
  }
  function carryOwner(retiredSessionId: string, canonicalSessionId: string) {
    const knownCwds: (string | null)[] = [];
    for (const receipt of openReceipts)
      if (receipt.sessionId === retiredSessionId) {
        knownCwds.push(receipt.cwd);
        receipt.sessionId = canonicalSessionId;
      }
    // The owner may be offscreen, but its preferences and outstanding receipts still follow its rekey.
    set((s) => {
      const visible = s.canvasSessionId === retiredSessionId;
      const ownerCwd = s.canvasSessionCwd !== undefined ? s.canvasSessionCwd : s.selectedCwd;
      const panelViewPreferences = remapClosedPanelSession(
        s.panelViewPreferences,
        retiredSessionId,
        canonicalSessionId,
        [...knownCwds, ...(visible ? [ownerCwd] : [])]
      );
      writePanelViewPreferences(panelViewPreferences);
      return {
        ...(visible
          ? {
              canvasSessionId: canonicalSessionId,
              canvasSessionCwd: ownerCwd,
              canvasStreamAttached: false,
            }
          : {}),
        panelViewPreferences,
      };
    });
  }
  function prepareBinding(sessionId: string) {
    if (
      get().selectedCwd !== null &&
      (get().canvasSessionId !== sessionId || get().canvasSessionCwd === null)
    ) {
      for (const receipt of openReceipts)
        if (receipt.sessionId === sessionId && receipt.cwd === null)
          receipt.cwd = get().selectedCwd;
    }
  }
  function bindResolvedDirectory(sessionId: string, s: AppState) {
    const cwd = s.selectedCwd;
    if (cwd === null)
      return { canvasSessionCwd: cwd, panelViewPreferences: s.panelViewPreferences };
    const nextScope = documentPanelScope(sessionId, cwd);
    const panelViewPreferences = remapClosedPanelScope(
      remapClosedPanelScope(s.panelViewPreferences, documentPanelScope(sessionId, null), nextScope),
      legacyDocumentPanelScope(sessionId, null),
      nextScope
    );
    writePanelViewPreferences(panelViewPreferences);
    return { canvasSessionCwd: cwd, panelViewPreferences };
  }
  return {
    beginOpen,
    finish,
    captureSelection,
    carryOwner,
    prepareBinding,
    bindResolvedDirectory,
    settlePending,
  };
}
