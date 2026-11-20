import { useState } from 'react';
import { toast } from 'sonner';
import type { BackupCopyInfo } from '@dorkos/shared/transport-backups';
import { Button, DirectoryPicker, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { formatBytes, useBackups, useMoveBackup, useRemoveBackup } from '../../model/use-backups';
import { BackupRow } from './BackupRow';
import { RemoveBackupDialog } from './RemoveBackupDialog';
import { TypedPathMove } from './TypedPathMove';

/** The thrown error's own sentence (the server's), else a plain fallback. */
function sentenceOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.';
}

/**
 * Settings → This computer → Backups (DOR-4253): every copy of this computer's
 * DorkOS database, with the space they take.
 *
 * DorkOS prunes its own `dork-auto-` copies. Copies made before that are never
 * touched automatically, so this is where a person removes them, or moves them
 * somewhere else, one at a time.
 */
export function BackupsTab() {
  const backups = useBackups();
  const remove = useRemoveBackup();
  const move = useMoveBackup();
  const [removing, setRemoving] = useState<BackupCopyInfo | null>(null);
  const [moving, setMoving] = useState<BackupCopyInfo | null>(null);
  const [typedError, setTypedError] = useState<string | null>(null);
  const working = remove.isPending || move.isPending;
  // Which copy the running action is on, so only its row says so.
  const acting = remove.isPending
    ? { name: remove.variables, label: 'removing' as const }
    : move.isPending
      ? { name: move.variables?.name, label: 'moving' as const }
      : null;

  function confirmRemove(copy: BackupCopyInfo) {
    setRemoving(null);
    remove.mutate(copy.name, {
      onSuccess: () => toast.success('Backup removed.'),
      onError: (err) => toast.error(sentenceOf(err)),
    });
  }

  function moveTo(copy: BackupCopyInfo, destination: string) {
    setMoving(null);
    move.mutate(
      { name: copy.name, destination },
      {
        onSuccess: ({ destinationPath }) =>
          toast.success('Backup moved.', { description: destinationPath }),
        onError: (err) => toast.error(sentenceOf(err)),
      }
    );
  }

  /** A typed folder keeps the dialog open, so a refusal can be read and fixed in place. */
  function moveToTyped(copy: BackupCopyInfo, destination: string) {
    setTypedError(null);
    move.mutate(
      { name: copy.name, destination },
      {
        onSuccess: ({ destinationPath }) => {
          setMoving(null);
          toast.success('Backup moved.', { description: destinationPath });
        },
        onError: (err) => setTypedError(sentenceOf(err)),
      }
    );
  }

  function openMove(copy: BackupCopyInfo) {
    setTypedError(null);
    setMoving(copy);
  }

  if (backups.isPending) {
    return <p className="text-muted-foreground text-sm">Reading backups…</p>;
  }
  if (backups.isError) {
    return (
      <div className="space-y-2">
        <p className="text-sm">{sentenceOf(backups.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void backups.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const { copies, totalBytes, folder } = backups.data;
  const olderCount = copies.filter((copy) => !copy.managed).length;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium" data-testid="backups-total">
          {copies.length === 0
            ? 'No backups on this computer yet.'
            : `Backups use ${formatBytes(totalBytes)} on this computer.`}
        </p>
        <p className="text-muted-foreground text-xs">
          DorkOS keeps a few recent copies and removes the rest itself.
        </p>
        {olderCount > 0 && (
          <p className="text-muted-foreground text-xs">
            Older copies stay until you remove or move them.
          </p>
        )}
        <p className="text-muted-foreground truncate font-mono text-xs" title={folder}>
          {folder}
        </p>
      </div>

      {copies.length > 0 && (
        <FieldCard>
          <FieldCardContent>
            <ul className="divide-border divide-y" aria-label="Backups">
              {copies.map((copy) => (
                <BackupRow
                  key={copy.name}
                  copy={copy}
                  working={working}
                  {...(acting?.name === copy.name ? { acting: acting.label } : {})}
                  onMove={openMove}
                  onRemove={setRemoving}
                />
              ))}
            </ul>
          </FieldCardContent>
        </FieldCard>
      )}
      {/* One announcement for screen readers while a Remove or Move runs. */}
      <p className="sr-only" aria-live="polite">
        {acting ? (acting.label === 'moving' ? 'Moving backup…' : 'Removing backup…') : ''}
      </p>

      <RemoveBackupDialog
        copy={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={confirmRemove}
      />
      <DirectoryPicker
        open={moving !== null}
        onOpenChange={(open) => !open && setMoving(null)}
        onSelect={(destination) => moving && moveTo(moving, destination)}
        title="Move backup to…"
        note="Older copies can include past chats. A folder that syncs will upload them."
        browseOnly
        extra={
          <TypedPathMove
            onSubmit={(destination) => moving && moveToTyped(moving, destination)}
            error={typedError}
            pending={move.isPending}
          />
        }
      />
    </div>
  );
}
