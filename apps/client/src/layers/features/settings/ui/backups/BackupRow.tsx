import type { BackupCopyInfo } from '@dorkos/shared/transport-backups';
import { Badge, Button } from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import { formatBytes } from '../../model/use-backups';

/** What each kind of copy is called on the page. */
const KIND_LABEL: Record<BackupCopyInfo['kind'], string> = {
  daily: 'Daily backup',
  'pre-upgrade': 'Before an update',
};

/** What the row says while its own action runs. */
const ACTING_LABEL = { moving: 'Moving…', removing: 'Removing…' } as const;

interface BackupRowProps {
  copy: BackupCopyInfo;
  /** An action is running somewhere on the page, so this row's buttons wait. */
  working: boolean;
  /** The action running on THIS copy, if any. */
  acting?: keyof typeof ACTING_LABEL;
  onMove: (copy: BackupCopyInfo) => void;
  onRemove: (copy: BackupCopyInfo) => void;
}

/**
 * One backup copy: what it is, how old and how big, and who looks after it.
 * Only an older copy offers Move and Remove; DorkOS prunes its own.
 */
export function BackupRow({ copy, working, acting, onMove, onRemove }: BackupRowProps) {
  const disabled = working || copy.busy;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 space-y-0.5">
        {/* On a phone the badge gets its own line, so every row lines up the same way. */}
        <div className="flex flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <p className="text-sm font-medium">{KIND_LABEL[copy.kind]}</p>
          <Badge tone="neutral" icon={null}>
            {copy.managed ? 'Kept by DorkOS' : 'Older copy'}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          {formatRelativeTime(copy.createdAt)} · {formatBytes(copy.sizeBytes)}
          {/* Says why Move and Remove are off; text rather than a tooltip, so it reads on touch. */}
          {copy.busy ? ' · In use · DorkOS is reading it' : ''}
          {acting ? <span aria-hidden="true"> · {ACTING_LABEL[acting]}</span> : null}
        </p>
        <p className="text-muted-foreground truncate font-mono text-xs" title={copy.name}>
          {copy.name}
        </p>
      </div>
      {!copy.managed && (
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onMove(copy)}
            aria-label={`Move ${copy.name}`}
          >
            Move
          </Button>
          {/* Quiet here; the filled red belongs to the "Remove this backup?" confirm. */}
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={disabled}
            onClick={() => onRemove(copy)}
            aria-label={`Remove ${copy.name}`}
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}
