/**
 * "Found on this computer": the Claude account folders DorkOS found and has
 * not been told about, offered below the registered accounts (spec
 * `claude-account-ui` §6.9, decision §8 option A).
 *
 * @module features/settings/ui/runtimes/sections/FoundAccountsGroup
 */

import { useId } from 'react';
import { CircleAlert } from 'lucide-react';
import type { FoundClaudeFolder } from '@dorkos/shared/account-usage';
import { cn, shortenHomePath } from '@/layers/shared/lib';
import { Button, STATUS_TONE_SURFACE } from '@/layers/shared/ui';

/** Props for {@link FoundAccountsGroup}. */
export interface FoundAccountsGroupProps {
  /** The folders to offer, in the server's order. */
  folders: readonly FoundClaudeFolder[];
  /** Register this folder as an account. */
  onAdd: (folder: FoundClaudeFolder) => void;
  /** Stop offering this folder. */
  onDismiss: (folder: FoundClaudeFolder) => void;
  /** A refused write, shown under the row whose folder it names. */
  error?: { path: string; message: string } | null;
  /** True while a write is in flight, so a second click cannot race it. */
  disabled?: boolean;
}

/** Midnight at the start of `date`'s local calendar day, in ms. */
function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "used today" / "used yesterday" / "used N days ago", by local calendar day,
 * or `null` when the last use is unknown or unreadable.
 */
function lastUsedText(lastUsedAt: string | null, now: Date): string | null {
  if (lastUsedAt === null) return null;
  const used = new Date(lastUsedAt);
  if (Number.isNaN(used.getTime())) return null;
  // Rounded, because a day that crosses a daylight-saving change is 23 or 25 hours.
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(used)) / 86_400_000);
  if (days <= 0) return 'used today';
  if (days === 1) return 'used yesterday';
  return `used ${days} days ago`;
}

/**
 * The account folders found on this computer, each with Add and Dismiss.
 * Renders nothing when there are none, so the group disappears once every
 * folder is added or dismissed. A folder that looks managed by an
 * organization is flagged in words, and its Add is not the primary button,
 * so adding it is a deliberate choice.
 *
 * Presentational: the section that renders it owns the reads and writes.
 */
export function FoundAccountsGroup({
  folders,
  onAdd,
  onDismiss,
  error = null,
  disabled = false,
}: FoundAccountsGroupProps) {
  const captionId = useId();
  if (folders.length === 0) return null;
  const now = new Date();
  return (
    <div
      role="group"
      aria-labelledby={captionId}
      className="bg-muted/50 rounded-md border border-dashed px-3 py-1.5"
      data-testid="found-accounts-group"
    >
      <p id={captionId} className="text-muted-foreground py-1 text-xs">
        Found on this computer
      </p>
      <ul className="divide-y">
        {folders.map((folder) => {
          const used = lastUsedText(folder.lastUsedAt, now);
          const rowError = error?.path === folder.path ? error.message : null;
          return (
            <li key={folder.path} className="py-2" data-testid="found-account-row">
              <div className="flex flex-wrap items-center gap-2">
                {/* Wide enough for a name and its path; on a phone the buttons
                    wrap under it rather than squeezing the text. */}
                <div className="min-w-40 flex-1">
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
                    <span className="font-semibold break-all">{folder.name}</span>
                    {used && (
                      <span className="text-muted-foreground text-xs whitespace-nowrap">
                        · {used}
                      </span>
                    )}
                    {folder.orgManaged && (
                      <span
                        className={cn(
                          'text-2xs rounded-full px-2 leading-5 whitespace-nowrap',
                          STATUS_TONE_SURFACE.warning
                        )}
                      >
                        managed by an organization
                      </span>
                    )}
                  </p>
                  <p
                    className="text-muted-foreground truncate font-mono text-xs"
                    title={folder.path}
                  >
                    {shortenHomePath(folder.path)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={folder.orgManaged ? 'outline' : 'default'}
                    onClick={() => onAdd(folder)}
                    disabled={disabled}
                    aria-label={`Add ${folder.name}`}
                  >
                    Add
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onDismiss(folder)}
                    disabled={disabled}
                    aria-label={`Dismiss ${folder.name}`}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
              {rowError && (
                <p
                  role="alert"
                  className="text-destructive mt-1 flex items-start gap-1.5 text-xs"
                  data-testid="found-account-error"
                >
                  <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
                  <span>{rowError}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
