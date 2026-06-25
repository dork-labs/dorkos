import { GitBranch, ArrowUp, ArrowDown, Pin } from 'lucide-react';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';
import type { Workspace } from '@dorkos/shared/workspace';
import { derivePorts } from '@dorkos/shared/workspace';
import { isGitStatusOk } from '../model/use-git-status';

interface GitStatusItemProps {
  data: GitStatusResponse | GitStatusError | undefined;
  /**
   * The managed workspace the session is bound to (DOR-84). When present, the
   * item leads with the workspace identity (`⎇ <key> · <project>`) and moves the
   * branch/provider/ports/pinned detail into the tooltip. When absent, the item
   * renders exactly as the plain git-status chip ("main checkout" case).
   */
  workspace?: Workspace | null;
}

/** Status bar item: the workspace identity (when bound) or the git branch, plus change counts. */
export function GitStatusItem({ data, workspace }: GitStatusItemProps) {
  if (!data) return null;

  // Not a git repo — show disabled state
  if (!isGitStatusOk(data)) {
    return (
      <span
        className="text-muted-foreground/50 inline-flex items-center gap-1"
        title="Not a git repository"
      >
        <GitBranch className="size-(--size-icon-xs)" />
        <span>No repo</span>
      </span>
    );
  }

  const totalChanges = data.modified + data.staged + data.untracked;
  const changeLabel = totalChanges === 1 ? '1 change' : `${totalChanges} changes`;

  // Shared change breakdown for the tooltip.
  const changeParts: string[] = [];
  if (data.modified > 0) changeParts.push(`${data.modified} modified`);
  if (data.staged > 0) changeParts.push(`${data.staged} staged`);
  if (data.untracked > 0) changeParts.push(`${data.untracked} untracked`);
  if (data.conflicted > 0) changeParts.push(`${data.conflicted} conflicted`);

  // Workspace-led rendering (the session is bound to a managed workspace).
  if (workspace) {
    const ports = derivePorts(workspace.portBase);
    const tipParts = [
      `${workspace.branch ?? data.branch} · ${workspace.provider}`,
      data.ahead > 0 ? `↑${data.ahead}` : '',
      data.behind > 0 ? `↓${data.behind}` : '',
      changeParts.length > 0 ? changeParts.join(', ') : 'clean',
      `ports ${ports.DORKOS_PORT} / ${ports.VITE_PORT} / ${ports.SITE_PORT}`,
      workspace.pinned ? 'pinned' : '',
    ].filter(Boolean);

    return (
      <span className="inline-flex items-center gap-1" title={tipParts.join(' · ')}>
        <GitBranch className="size-(--size-icon-xs)" />
        <span className="max-w-[20ch] truncate font-medium">{workspace.key}</span>
        <span className="text-muted-foreground">· {workspace.projectKey}</span>
        {workspace.pinned && <Pin className="text-muted-foreground size-(--size-icon-xs)" />}
        {totalChanges > 0 && <span className="text-muted-foreground">· {changeLabel}</span>}
      </span>
    );
  }

  // Plain git-status rendering (unchanged — "main checkout" / unmanaged cwd).
  const tooltip =
    changeParts.length > 0
      ? `${data.branch} · ${changeParts.join(', ')}`
      : `${data.branch} · clean`;

  return (
    <span className="inline-flex items-center gap-1" title={tooltip}>
      <GitBranch className="size-(--size-icon-xs)" />
      <span className="max-w-[25ch] truncate">{data.branch}</span>

      {data.ahead > 0 && (
        <span className="text-muted-foreground inline-flex items-center gap-0.5">
          <ArrowUp className="size-(--size-icon-xs)" />
          {data.ahead}
        </span>
      )}
      {data.behind > 0 && (
        <span className="text-muted-foreground inline-flex items-center gap-0.5">
          <ArrowDown className="size-(--size-icon-xs)" />
          {data.behind}
        </span>
      )}

      {totalChanges > 0 && <span className="text-muted-foreground">· {changeLabel}</span>}
    </span>
  );
}
