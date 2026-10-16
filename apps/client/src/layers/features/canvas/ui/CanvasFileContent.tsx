import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useResolvedTheme, useTransport } from '@/layers/shared/model';
import { fileContentQueryKey } from '../model/file-save/content-query';
import { FileEditor } from './file-save/FileEditor';
import { SessionFileEditor } from './file-save/SessionFileEditor';
interface CanvasFileContentProps {
  /** File canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'file' }>;
  /** Id of the canvas document this viewer belongs to (owns its edit-protection flag). */
  documentId: string;
}

/** Friendly message for a file-load failure, keyed by the transport's coded error. */
function loadErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'NOT_FOUND':
      return 'This file doesn’t exist.';
    case 'NOT_A_FILE':
      return 'This path is a directory, not a file.';
    case 'TOO_LARGE':
      return 'This file is too large to open here.';
    case 'BINARY_FILE':
      return 'This file isn’t text, so the editor can’t show it.';
    default:
      return 'This file couldn’t be loaded.';
  }
}

/**
 * File-backed canvas viewer/editor. Loads the file's text via the file-service
 * (cwd-confined), renders it read-only by default, and offers an edit toggle
 * that saves back through the optimistic-concurrency flow (409 → Reload /
 * Overwrite). Markdown files render in the rich Blintz editor; every other
 * text/code file renders in CodeMirror. While editing, the active document's
 * edit-protection flag holds agent pushes (ADR-0292).
 */
export function CanvasFileContent({ content, documentId }: CanvasFileContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);
  const setDocumentEditing = useAppStore((s) => s.setDocumentEditing);
  const documentEditing = useAppStore(
    (s) => s.openDocuments.find((d) => d.id === documentId)?.editing ?? false
  );
  const resolvedTheme = useResolvedTheme();
  const sessionId = useAppStore((s) => s.canvasSessionId);
  const roomId = useAppStore((s) => s.roomCanvasLiveRoomId);

  const { data, error, isLoading } = useQuery({
    queryKey: fileContentQueryKey(cwd as string, content.sourcePath),
    enabled: cwd !== null,
    queryFn: () => transport.readFileContent(cwd as string, content.sourcePath),
    staleTime: 30_000,
    retry: false,
  });

  // The edit session lives HERE (not in FileEditor) because it gates the
  // editor's mount key: while a session is open, the key stays pinned to the
  // hash the session opened with, so a refetch landing mid-edit (window
  // refocus, or Refresh clicked just before the pencil) updates the cache
  // WITHOUT remounting the editor and discarding the draft. Closing the
  // session unpins, letting the exit-time cache resync re-key the editor with
  // the just-saved bytes.
  const [editSession, setEditSession] = useState<{ pinnedHash: string } | null>(null);
  const handleEditingChange = (editing: boolean) => {
    setEditSession(editing && data ? { pinnedHash: data.hash } : null);
  };

  if (cwd === null) {
    return <FileMessage>Open a chat to view files.</FileMessage>;
  }
  if (isLoading) {
    return <FileMessage>Loading file…</FileMessage>;
  }
  if (error || !data) {
    return <FileMessage>{loadErrorMessage(error)}</FileMessage>;
  }

  // Edit mode is the AND of this viewer's own session and the store's flag for
  // this document, derived rather than mirrored. The flag can be cleared from
  // OUTSIDE — "Reload" on the held-update banner takes the agent's version and
  // ends the edit — and deriving is what lets that land on the next render
  // instead of through a state-sync effect.
  const editing = editSession !== null && documentEditing;

  // Remount the editor when the loaded document identity changes (path or the
  // on-disk bytes) so edit state + save baseline never straddle two documents —
  // except mid-edit, where the pinned hash keeps the mounted editor stable. A
  // session the store has already ended pins nothing, so an edit ended from
  // outside cannot leave the key stuck on a hash no editor is showing.
  const mountHash = (editing ? editSession?.pinnedHash : null) ?? data.hash;

  const Editor = sessionId && !roomId ? SessionFileEditor : FileEditor;
  return (
    <Editor
      key={`${content.sourcePath}:${mountHash}`}
      content={content}
      documentId={documentId}
      cwd={cwd}
      loaded={data.content}
      theme={resolvedTheme}
      isEditing={editing}
      onEditingChange={handleEditingChange}
      setDocumentEditing={setDocumentEditing}
    />
  );
}

/** Centered muted message for empty/error/loading file states. */
function FileMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
      <p>{children}</p>
    </div>
  );
}
