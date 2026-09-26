/**
 * "Save to room files" — keep a file somebody attached to a message as one of
 * the room's own files (spec `agent-home-desk` §7.3).
 *
 * An attachment lives in the chat: it scrolls away with the conversation and
 * nobody's agent reads it as part of the project. A room's files are the
 * project. This is the one step between the two — pick a folder, keep or change
 * the name, save — and it lands as one commit with the person's name on it and
 * one quiet line in the room.
 *
 * **Offered only where it can work.** A room without files of its own has
 * nowhere to put it, so the button is not drawn there at all; the question is
 * answered by the same cached listing the Files section reads, so asking it
 * costs nothing the panel has not already asked.
 *
 * @module features/file-explorer/ui/SaveToRoomFiles
 */
import { useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CornerLeftUp, Folder, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import type { RoomAttachment } from '@dorkos/shared/room-schemas';
import {
  Button,
  Input,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Spinner,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { useRoom } from '@/layers/entities/room';
import { freeCopyName } from '../lib/copy-name';
import { roomChangeRefusalMessage } from '../lib/crud-errors';
import { withoutHidden } from '../lib/listing-shape';
import { changeRefusal, createRoomFilesSource } from '../model/room-files-source';
import { explorerDirQueryOptions, type FileExplorerSource } from '../model/source';
import { baseName, joinPath, parentOf, ROOT_KEY } from '../model/tree';

/** What {@link SaveToRoomFilesButton} needs. */
export interface SaveToRoomFilesButtonProps {
  /** The room the message is in. */
  roomId: string;
  /** The file on the message. */
  attachment: RoomAttachment;
}

/**
 * The small button beside a chat attachment, and the dialog it opens — or
 * nothing, in a room without files of its own.
 *
 * @param props - The room and the attachment.
 */
export function SaveToRoomFilesButton({ roomId, attachment }: SaveToRoomFilesButtonProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const source = useMemo(
    () => createRoomFilesSource({ transport, queryClient, roomId }),
    [transport, queryClient, roomId]
  );
  // The same cache entry the Files section's root reads, by the same options.
  const root = useQuery(explorerDirQueryOptions(source, ROOT_KEY, false, queryClient));
  const [open, setOpen] = useState(false);
  // An archived room refuses every change to its files, so it offers none.
  const room = useRoom(roomId);

  if (!root.isSuccess || root.data.absent === true) return null;
  if (room.data?.archived !== false) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Save ${attachment.name} to the room’s files`}
        title="Save to room files"
        className="text-muted-foreground hover:text-foreground mt-0.5 pointer-coarse:size-11"
        onClick={() => setOpen(true)}
      >
        <FolderInput />
      </Button>
      {open && (
        <SaveToRoomFilesDialog
          roomId={roomId}
          source={source}
          attachment={attachment}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** What {@link SaveToRoomFilesDialog} needs. */
interface SaveToRoomFilesDialogProps {
  roomId: string;
  source: FileExplorerSource;
  attachment: RoomAttachment;
  onClose: () => void;
}

/**
 * Pick a folder in the room's files and a name, and save the attachment there.
 *
 * The folder picker walks one folder at a time — into a folder by pressing it,
 * back out by the row above — which works the same with a thumb on a phone as
 * with a mouse, and never needs a tree wider than the drawer.
 */
function SaveToRoomFilesDialog({
  roomId,
  source,
  attachment,
  onClose,
}: SaveToRoomFilesDialogProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [dir, setDir] = useState<string>(ROOT_KEY);
  const [name, setName] = useState(attachment.name);
  const [problem, setProblem] = useState<{ reason: string; suggestion?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const nameId = useId();

  const listing = useQuery(explorerDirQueryOptions(source, dir, false, queryClient));
  const folders = useMemo(
    () => withoutHidden(listing.data?.entries ?? []).filter((entry) => entry.type === 'dir'),
    [listing.data]
  );

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setSaving(true);
    setProblem(null);
    try {
      await transport.saveAttachmentToRoomFiles(roomId, {
        attachmentId: attachment.id,
        dir,
        name: trimmed,
        baseCommit: listing.data?.commit ?? null,
      });
      void queryClient.invalidateQueries({ queryKey: ['file-explorer', 'tree', source.scopeKey] });
      toast.success(`Saved ${trimmed} to the room’s files`);
      onClose();
    } catch (error) {
      let outcome;
      try {
        outcome = changeRefusal(error, queryClient, roomId);
      } catch {
        outcome = {
          status: 'refused' as const,
          reason: roomChangeRefusalMessage(error) ?? 'That didn’t save. Try again in a moment.',
        };
      }
      if (outcome.status === 'exists') {
        // Nothing here replaces: a file somebody put in the room stays theirs.
        // So the answer is another name, and the dialog offers one.
        const taken = (listing.data?.entries ?? []).map((entry) => entry.name);
        setProblem({
          reason: `This folder already has a file called “${trimmed}”. Pick another name.`,
          suggestion: freeCopyName({ name: trimmed, isDir: false, taken: [...taken, trimmed] }),
        });
      } else if (outcome.status === 'conflict') {
        setProblem({
          reason:
            'Somebody changed this folder while you were choosing, so nothing was saved. Try again.',
        });
        void listing.refetch();
      } else if (outcome.status === 'refused') {
        setProblem({ reason: outcome.reason });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(next) => !next && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Save to room files</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Keep this file with the room’s files, where everyone in the room and their agents can
            find it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium">Folder</p>
            <div
              role="group"
              aria-label="Folders"
              className="border-border/60 max-h-56 overflow-auto rounded-md border"
            >
              <p className="bg-muted/40 truncate px-3 py-1.5 font-mono text-xs">
                {dir === ROOT_KEY ? 'Top folder' : `${dir}/`}
              </p>
              {dir !== ROOT_KEY && (
                <FolderRow
                  label="Up one folder"
                  icon={<CornerLeftUp className="text-muted-foreground size-(--size-icon-sm)" />}
                  onClick={() => setDir(parentOf(dir))}
                />
              )}
              {listing.isPending ? (
                <div className="flex h-12 items-center justify-center">
                  <Spinner size="sm" className="text-muted-foreground" label="Loading folders" />
                </div>
              ) : folders.length === 0 ? (
                <p className="text-muted-foreground px-3 py-2 text-xs">No folders in here.</p>
              ) : (
                folders.map((folder) => (
                  <FolderRow
                    key={folder.path}
                    label={folder.name}
                    icon={<Folder className="size-(--size-icon-sm) text-sky-500" />}
                    chevron
                    onClick={() => setDir(joinPath(dir, baseName(folder.path)))}
                  />
                ))
              )}
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor={nameId} className="text-muted-foreground text-xs font-medium">
              Name
            </label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {problem !== null && (
            <div role="alert" className="text-destructive space-y-1 text-xs">
              <p>{problem.reason}</p>
              {problem.suggestion !== undefined && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setName(problem.suggestion!);
                    setProblem(null);
                  }}
                >
                  Use “{problem.suggestion}”
                </Button>
              )}
            </div>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || name.trim() === '' || listing.isPending}
            onClick={() => void save()}
          >
            {saving
              ? 'Saving…'
              : dir === ROOT_KEY
                ? 'Save to the top folder'
                : `Save to ${baseName(dir)}`}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** One row of the folder picker. */
function FolderRow({
  label,
  icon,
  chevron = false,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-accent/50 focus-visible:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chevron && <ChevronRight className="text-muted-foreground size-3.5" />}
    </button>
  );
}
