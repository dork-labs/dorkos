import { History } from 'lucide-react';
import type { DocRef, DocVersion } from '@dorkos/shared/doc-collab';
import { formatRelativeTime } from '@/layers/shared/lib';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/layers/shared/ui';
import { useDocVersions, useRestoreDocVersion } from '@/layers/entities/doc';

/** Props for {@link VersionsMenu}. */
export interface VersionsMenuProps {
  /** The doc. */
  doc: DocRef;
  /** Called after a restore lands, with whether the doc was open live. */
  onRestored?: (live: boolean) => void;
}

/** What one version is, in a few words. */
function versionLabel(version: DocVersion): string {
  if (version.reason === 'unsaved-edits') return 'Your unsaved edits';
  const by = version.changedBy;
  if (by.kind === 'disk') return 'Before a change on disk';
  if (by.kind === 'person') return 'Before a restore';
  return `Before ${by.name ?? 'an agent'}’s change`;
}

/**
 * The doc's saved versions, to pick one and put it back (DOR-2984; the
 * DOR-2983 "Restore previous version" decision). Shown once a version exists.
 * Restoring replaces the doc; what it said before is kept as a version, so a
 * restore can be undone the same way.
 */
export function VersionsMenu({ doc, onRestored }: VersionsMenuProps) {
  const versions = useDocVersions(doc);
  const restore = useRestoreDocVersion(doc);
  const list = versions.data ?? [];
  if (list.length === 0) return null;
  return (
    <span className="flex items-center gap-2">
      {restore.isError && (
        <span role="status" className="text-destructive text-xs">
          Couldn’t restore. Try again.
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-7 gap-1.5"
            disabled={restore.isPending}
          >
            <History className="size-3.5" />
            Versions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Restoring replaces the doc. Its current text is kept as a version.
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {list.map((version) => (
            <DropdownMenuItem
              key={version.id}
              onSelect={() =>
                restore.mutate(version.id, { onSuccess: (result) => onRestored?.(result.live) })
              }
            >
              <span className="flex-1 truncate">{versionLabel(version)}</span>
              <span className="text-muted-foreground text-xs">
                {formatRelativeTime(version.savedAt)}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
