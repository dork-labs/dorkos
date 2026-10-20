/** Owned editor close preparation; it grants no server authority and never writes a draft itself. */
import { toast } from 'sonner';
import type { AppState } from './app-store-types';
import type { CanvasDocument, SessionCanvasTransport } from './app-store-canvas';
import { prunePendingCandidates } from './canvas-document-candidates';

type Preparation = {
  required(): boolean;
  current(): boolean;
  prepare(): Promise<boolean>;
  invalidateConfirmedFile(): void;
};
type Entry = {
  openedAt: number;
  sourcePath: string;
  preparation: Preparation;
  retired: boolean;
  retirement?: Promise<boolean>;
  resolveRetirement?: (confirmed: boolean) => void;
};
const entries = new Map<string, Set<Entry>>();
const generations = new Map<string, number>();
const pendingCloses = new Map<string, Promise<void>>();
function removeEntry(documentId: string, entry: Entry): void {
  const own = entries.get(documentId);
  own?.delete(entry);
  if (own?.size === 0) {
    entries.delete(documentId);
    if (!pendingCloses.has(documentId)) generations.delete(documentId);
  }
}
/** Register one committed mounted file owner. Retirement retains only its already-authorized drain. */
export function registerCanvasDocumentClosePreparation(
  documentId: string,
  openedAt: number,
  sourcePath: string,
  preparation: Preparation
) {
  const entry: Entry = { openedAt, sourcePath, preparation, retired: false };
  const own = entries.get(documentId) ?? new Set<Entry>();
  own.add(entry);
  entries.set(documentId, own);
  generations.set(documentId, (generations.get(documentId) ?? 0) + 1);
  return {
    retire() {
      if (entry.retired) return;
      entry.retired = true;
      if (!entry.preparation.required()) {
        removeEntry(documentId, entry);
        return;
      }
      entry.retirement = new Promise((resolve) => {
        entry.resolveRetirement = resolve;
      });
    },
    settleRetirement(confirmed: Promise<boolean>) {
      if (!entry.retired || !entry.resolveRetirement) return;
      const resolve = entry.resolveRetirement;
      entry.resolveRetirement = undefined;
      void confirmed.then(
        (value) => {
          if (value) {
            entry.preparation.invalidateConfirmedFile();
            removeEntry(documentId, entry);
          }
          resolve(value);
        },
        () => resolve(false)
      );
    },
  };
}
interface CloseDependencies {
  get(): AppState;
  getTransport(): SessionCanvasTransport | null;
  set(update: (state: AppState) => Partial<AppState>): void;
  stopHeartbeat(id: string): void;
  cancelHeldWrites(id: string): void;
  writesAwaitingEcho: { delete(id: string): boolean };
  reconcileActiveIds(documents: CanvasDocument[], current: AppState): Partial<AppState>;
  pruneBrowserHistories(
    history: AppState['browserHistories'],
    documents: CanvasDocument[]
  ): AppState['browserHistories'];
  writeThrough(
    sessionId: string | null,
    id: string,
    write: (transport: SessionCanvasTransport, sessionId: string) => Promise<unknown>,
    revert: () => void
  ): void;
}
/** Preserve legacy synchronous close; receipt owners settle while still mounted before any removal. */
export function closeCanvasDocumentWithSave(
  id: string,
  deps: CloseDependencies
): void | Promise<void> {
  const before = deps.get(),
    closed = before.openDocuments.find((row) => row.id === id);
  if (!closed) return;
  const transport = deps.getTransport();
  const current = () => {
    const state = deps.get(),
      row = state.openDocuments.find((item) => item.id === id);
    return (
      !!row &&
      deps.getTransport() === transport &&
      state.canvasSessionId === before.canvasSessionId &&
      state.selectedCwd === before.selectedCwd &&
      row.openedAt === closed.openedAt &&
      row.rev === closed.rev &&
      row.content.type === closed.content.type &&
      (row.content.type !== 'file' ||
        closed.content.type !== 'file' ||
        row.content.sourcePath === closed.content.sourcePath)
    );
  };
  const finish = () => {
    if (!current()) return;
    const restored = deps.get().openDocuments.find((row) => row.id === id)!;
    deps.stopHeartbeat(id);
    deps.cancelHeldWrites(id);
    deps.writesAwaitingEcho.delete(id);
    deps.set((state) => {
      const documents = prunePendingCandidates(state.openDocuments.filter((row) => row.id !== id));
      return {
        openDocuments: documents,
        ...deps.reconcileActiveIds(documents, state),
        browserHistories: deps.pruneBrowserHistories(state.browserHistories, documents),
      };
    });
    if (id.startsWith('pending:')) return;
    deps.writeThrough(
      before.canvasSessionId,
      id,
      (transport, sessionId) => transport.closeSessionCanvasDocument(sessionId, id),
      () =>
        deps.set((state) => {
          if (state.openDocuments.some((row) => row.id === id)) return {};
          const documents = [...state.openDocuments, restored];
          return { openDocuments: documents, ...deps.reconcileActiveIds(documents, state) };
        })
    );
  };
  const own = [...(entries.get(id) ?? [])].filter(
    (entry) => entry.retired || entry.preparation.required()
  );
  if (!own.length) {
    finish();
    return;
  }
  const existing = pendingCloses.get(id);
  if (existing) return existing;
  const generation = generations.get(id);
  const attempt = Promise.resolve()
    .then(async () => {
      for (const entry of own) {
        const matches =
          closed.openedAt === entry.openedAt &&
          closed.content.type === 'file' &&
          closed.content.sourcePath === entry.sourcePath;
        const confirmed =
          matches && (entry.retired ? await entry.retirement : await entry.preparation.prepare());
        if (
          !confirmed ||
          !current() ||
          generations.get(id) !== generation ||
          (!entry.retired && !entry.preparation.current())
        ) {
          toast.error('Save this document before closing it', {
            description: 'Keep it open and resolve the original save first.',
          });
          return;
        }
      }
      finish();
    })
    .catch(() => {
      toast.error('The document could not be saved', {
        description: 'It remains open so you can retry.',
      });
    })
    .finally(() => {
      if (pendingCloses.get(id) === attempt) pendingCloses.delete(id);
      if (!entries.has(id)) generations.delete(id);
    });
  pendingCloses.set(id, attempt);
  return attempt;
}
