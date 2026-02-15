import { GitBranch, ArrowUp, ArrowDown } from 'lucide-react';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';
import { isGitStatusOk } from '../model/use-git-status';

interface GitStatusItemProps {
  data: GitStatusResponse | GitStatusError | undefined;
}

export function GitStatusItem({ data }: GitStatusItemProps) {
  if (!data) return null;

  // Not a git repo — show disabled state
  if (!isGitStatusOk(data)) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/50" title="Not a git repository">
        <GitBranch className="size-(--size-icon-xs)" />
        <span>No repo</span>
      </span>
    );
  }

  const totalChanges = data.modified + data.staged + data.untracked;
  const changeLabel = totalChanges === 1 ? '1 change' : `${totalChanges} changes`;

  // Build tooltip breakdown
  const parts: string[] = [];
  if (data.modified > 0) parts.push(`${data.modified} modified`);
  if (data.staged > 0) parts.push(`${data.staged} staged`);
  if (data.untracked > 0) parts.push(`${data.untracked} untracked`);
  if (data.conflicted > 0) parts.push(`${data.conflicted} conflicted`);
  const tooltip = parts.length > 0
    ? `${data.branch} · ${parts.join(', ')}`
    : `${data.branch} · clean`;

  return (
    <span className="inline-flex items-center gap-1" title={tooltip}>
      <GitBranch className="size-(--size-icon-xs)" />
      <span className="max-w-[25ch] truncate">{data.branch}</span>

      {data.ahead > 0 && (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          <ArrowUp className="size-(--size-icon-xs)" />
          {data.ahead}
        </span>
      )}
      {data.behind > 0 && (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          <ArrowDown className="size-(--size-icon-xs)" />
          {data.behind}
        </span>
      )}

      {totalChanges > 0 && (
        <span className="text-muted-foreground">· {changeLabel}</span>
      )}
    </span>
  );
}
