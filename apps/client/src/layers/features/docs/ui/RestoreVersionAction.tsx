import { History } from 'lucide-react';
import type { DocRef } from '@dorkos/shared/doc-collab';
import { formatRelativeTime } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { useDocVersions, useRestoreDocVersion } from '@/layers/entities/doc';

/** Props for {@link RestoreVersionAction}. */
export interface RestoreVersionActionProps {
  /** The doc. */
  doc: DocRef;
  /** Called after a restore lands, so a non-live editor can reload the file. */
  onRestored?: (live: boolean) => void;
}

/** Whose change the newest saved version comes from just before. */
function beforeWhom(name: string | undefined, kind: 'agent' | 'person' | 'disk'): string {
  if (kind === 'disk') return 'the change on disk';
  if (kind === 'person') return 'the last restore';
  return `${name ?? 'an agent'}’s change`;
}

/**
 * "Restore previous version" for a file-backed doc: puts back the doc as it
 * was before the last change made outside its editor (an agent's write, say).
 * Shown only when such a version exists. Restoring keeps what it replaced, so
 * pressing it again undoes the restore.
 */
export function RestoreVersionAction({ doc, onRestored }: RestoreVersionActionProps) {
  const versions = useDocVersions(doc);
  const restore = useRestoreDocVersion(doc);
  const newest = versions.data?.[0];
  if (!newest) return null;
  const when = formatRelativeTime(newest.savedAt);
  return (
    <span className="flex items-center gap-2">
      {restore.isError && (
        <span role="status" className="text-destructive text-xs">
          Couldn’t restore. Try again.
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-7 gap-1.5"
        disabled={restore.isPending}
        title={`The doc before ${beforeWhom(newest.changedBy.name, newest.changedBy.kind)}, ${when}`}
        onClick={() =>
          restore.mutate(newest.id, { onSuccess: (result) => onRestored?.(result.live) })
        }
      >
        <History className="size-3.5" />
        Restore previous version
      </Button>
    </span>
  );
}
