import { GitBranch, ArrowUp, ArrowDown, Pin } from 'lucide-react';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';
import type { Workspace } from '@dorkos/shared/workspace';
import { derivePorts } from '@dorkos/shared/workspace';
import { isGitStatusOk } from '../model/use-git-status';
import { compactStatusValue } from '../lib/status-labels';

interface GitStatusItemProps {
  data: GitStatusResponse | GitStatusError | undefined;
  /**
   * The managed workspace the session is bound to (DOR-84). When present, the
   * item leads with the workspace identity (`⎇ <key> · <project>`) and moves the
   * branch/provider/ports/pinned detail into the tooltip. When absent, the item
   * renders exactly as the plain git-status chip ("main checkout" case).
   */
  workspace?: Workspace | null;
  /**
   * Say it in as few pixels as possible — set below the status line's widest
   * tier, like every other item that can be verbose.
   *
   * This item was the exception, and it was the widest thing in the line because
   * of it: a 25-character branch plus the project key plus `· 6 changes` measured
   * 235px, where a slot is priced at 13 characters (`STATUS_VALUE_MAX_CHARS`).
   * The whole width budget rests on the claim that items are roughly one size, so
   * the one item that ignored the bound squeezed everything beside it (DOR-461).
   * Compact keeps what makes the item news — the branch, ahead/behind, and a dot
   * for "there are uncommitted changes", since a dirty tree is half of why this
   * item promotes at all and dropping it made a dirty repo and a clean one on the
   * same branch identical. What it drops is the exact counts and the project key,
   * which the tooltip carries in full.
   */
  compact?: boolean;
}

/** Status bar item: the workspace identity (when bound) or the git branch, plus change counts. */
export function GitStatusItem({ data, workspace, compact }: GitStatusItemProps) {
  if (!data) return null;

  // Not a git repo — show disabled state
  if (!isGitStatusOk(data)) {
    return (
      <span
        className="text-muted-foreground/50 inline-flex min-w-0 items-center gap-1"
        title="Not a git repository"
      >
        <GitBranch className="size-(--size-icon-xs) shrink-0" />
        <span className="truncate">No repo</span>
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
      // The project key is in here because compact stops drawing it, and this is
      // the only other place it appears anywhere in the client.
      `${workspace.key} · ${workspace.projectKey}`,
      `${workspace.branch ?? data.branch} · ${workspace.provider}`,
      data.ahead > 0 ? `↑${data.ahead}` : '',
      data.behind > 0 ? `↓${data.behind}` : '',
      changeParts.length > 0 ? changeParts.join(', ') : 'clean',
      `ports ${ports.DORKOS_PORT} / ${ports.VITE_PORT} / ${ports.SITE_PORT}`,
      workspace.pinned ? 'pinned' : '',
    ].filter(Boolean);

    return (
      <span className="inline-flex min-w-0 items-center gap-1" title={tipParts.join(' · ')}>
        <GitBranch className="size-(--size-icon-xs) shrink-0" />
        <span className="max-w-[20ch] truncate font-medium">
          {compact ? compactStatusValue(workspace.key) : workspace.key}
        </span>
        {!compact && (
          <span className="text-muted-foreground truncate">· {workspace.projectKey}</span>
        )}
        {workspace.pinned && (
          <Pin className="text-muted-foreground size-(--size-icon-xs) shrink-0" />
        )}
        {totalChanges > 0 &&
          (compact ? (
            <DirtyDot label={changeLabel} />
          ) : (
            <span className="text-muted-foreground shrink-0">· {changeLabel}</span>
          ))}
      </span>
    );
  }

  // Plain git-status rendering (unchanged — "main checkout" / unmanaged cwd).
  const tooltip =
    changeParts.length > 0
      ? `${data.branch} · ${changeParts.join(', ')}`
      : `${data.branch} · clean`;

  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={tooltip}>
      <GitBranch className="size-(--size-icon-xs) shrink-0" />
      <span className="max-w-[25ch] truncate">
        {compact ? compactStatusValue(data.branch) : data.branch}
      </span>

      {data.ahead > 0 && (
        <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5">
          <ArrowUp className="size-(--size-icon-xs)" />
          {data.ahead}
        </span>
      )}
      {data.behind > 0 && (
        <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5">
          <ArrowDown className="size-(--size-icon-xs)" />
          {data.behind}
        </span>
      )}

      {totalChanges > 0 &&
        (compact ? (
          <DirtyDot label={changeLabel} />
        ) : (
          <span className="text-muted-foreground shrink-0">· {changeLabel}</span>
        ))}
    </span>
  );
}

/**
 * The one bit of the change count that survives a narrow bar: that there is one.
 *
 * A dirty tree is half of what makes this item news (`dirty || !onDefaultBranch`),
 * so dropping the count wholesale left a dirty repo and a clean one on the same
 * feature branch rendering identically. Four pixels say the same thing, and the
 * exact tally is in the tooltip and the Session panel.
 *
 * @param props - The full change label, used as the accessible name.
 * @internal
 */
function DirtyDot({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="bg-muted-foreground/70 size-1 shrink-0 rounded-full"
    />
  );
}
