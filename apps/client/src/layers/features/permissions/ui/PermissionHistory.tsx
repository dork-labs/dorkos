import { useState } from 'react';
import type {
  PermissionHistoryEntry,
  PermissionUndoSkip,
  UndoPermissionChangeResponse,
} from '@dorkos/shared/permissions';
import {
  undoConflictsOf,
  usePermissionHistory,
  useUndoPermission,
} from '@/layers/entities/permissions';
import { formatRelativeTime } from '@/layers/shared/lib';
import { Button, Skeleton, stopLabel } from '@/layers/shared/ui';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { PERMISSION_STOPS } from '@dorkos/shared/permission-semantics';
import { PRESET_LABEL, STATE_LABEL } from '../lib/permission-copy';
import { reportPermissionFailure } from '../lib/report-failure';

/** Props for {@link PermissionHistory}. */
export interface PermissionHistoryProps {
  /** Narrow to the changes that touched one agent. */
  agentId?: string;
}

/**
 * A recorded value as the conflict question says it: "Ask", "Ask first",
 * "Full power", "the default". Read by what the key is, never by the value
 * alone: `ask` is the state Ask for an area and the stop Ask first for Files
 * & commands.
 */
function valueWord(value: string | null, change: PermissionUndoSkip['change']): string {
  if (value === null) return change.target.kind === 'agent' ? 'the default' : 'the preset';
  switch (change.key.kind) {
    case 'files':
      return isStop(value) ? stopLabel(value) : value;
    case 'preset':
      return value in PRESET_LABEL ? PRESET_LABEL[value as keyof typeof PRESET_LABEL] : value;
    default:
      return value in STATE_LABEL ? STATE_LABEL[value as keyof typeof STATE_LABEL] : value;
  }
}

/** True for a Files & commands stop. */
function isStop(value: string): value is PermissionStop {
  return (PERMISSION_STOPS as readonly string[]).includes(value);
}

/**
 * The question a refused Undo asks, using the real value it would write:
 * "This has changed since. Set it back to Ask anyway?"
 *
 * @param conflicts - What changed since, from the 409.
 */
export function conflictQuestion(conflicts: readonly PermissionUndoSkip[]): string {
  if (conflicts.length === 1) {
    const { change } = conflicts[0]!;
    return `This has changed since. Set it back to ${valueWord(change.before, change)} anyway?`;
  }
  return 'Some of this has changed since. Set it all back anyway?';
}

/**
 * What an Undo that left some of a change alone says: "Undid 3 changes. 1 had
 * changed since and was left alone." An Undo that found everything already
 * back says so too.
 *
 * @param result - The Undo's answer.
 */
export function partialUndoNote(result: UndoPermissionChangeResponse): string | null {
  // Undoing a "Not now" changes no setting; the line reading "Undone" says it.
  if (result.suggestionRestored) return null;
  if (result.changes.length === 0 && result.skipped.length === 0) {
    return 'Nothing to undo. It was already back.';
  }
  if (result.skipped.length === 0) return null;
  const done = result.changes.length;
  const head = `Undid ${done} ${done === 1 ? 'change' : 'changes'}.`;
  const changedSince = result.skipped.filter((s) => s.reason === 'changed-since').length;
  const locked = result.skipped.filter((s) => s.reason === 'floor').length;
  const gone = result.skipped.filter((s) => s.reason === 'gone').length;
  const parts: string[] = [];
  if (changedSince > 0) {
    parts.push(
      `${changedSince} had changed since and ${changedSince === 1 ? 'was' : 'were'} left alone.`
    );
  }
  if (locked > 0) {
    parts.push(
      `${locked} can’t be set to Allowed and ${locked === 1 ? 'was' : 'were'} left alone.`
    );
  }
  if (gone > 0) {
    parts.push(
      `${gone} ${gone === 1 ? 'was about an agent' : 'were about agents'} no longer here.`
    );
  }
  // One reason fits in a line; several would make a paragraph, so they collapse
  // to a count (the history list itself still shows each row as it stands).
  if (parts.length > 1) {
    const skipped = result.skipped.length;
    return `${head} ${skipped} ${skipped === 1 ? 'was' : 'were'} left alone.`;
  }
  return [head, ...parts].join(' ');
}

/** One history row, with its Undo. */
function HistoryRow({ item }: { item: PermissionHistoryEntry }) {
  const undo = useUndoPermission();
  const [conflicts, setConflicts] = useState<PermissionUndoSkip[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The server says which lines have an Undo (a change, or a "Not now") and
  // which are undone now, across the whole history: an undone Undo puts the
  // line it undid back in effect.
  const undone = item.undone;
  const undoable = item.undoable && !undone;
  const when = formatRelativeTime(item.occurredAt);

  const send = (force: boolean) =>
    undo.mutate(
      { eventId: item.id, ...(force ? { force: true as const } : {}) },
      {
        onSuccess: (result) => {
          setConflicts(null);
          setNote(partialUndoNote(result));
        },
        onError: (err) => {
          const found = undoConflictsOf(err);
          if (found) setConflicts(found);
          else reportPermissionFailure(err);
        },
      }
    );

  return (
    <li className="space-y-1" data-testid="permission-history-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm">{item.summary}</p>
          <p className="text-muted-foreground text-xs">
            {item.actorLabel} · {when}
          </p>
          {item.actorDetail ? (
            <p className="text-muted-foreground text-xs">{item.actorDetail}</p>
          ) : null}
        </div>
        {undone ? (
          <span className="text-muted-foreground shrink-0 pt-0.5 text-xs">Undone</span>
        ) : undoable && conflicts === null ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={undo.isPending}
            aria-label={`Undo: ${item.summary}, ${when}`}
            onClick={() => send(false)}
          >
            Undo
          </Button>
        ) : null}
      </div>
      {conflicts !== null ? (
        <div
          role="group"
          aria-label="Undo conflict"
          className="bg-muted/50 flex flex-col gap-2 rounded-md p-2 @md:flex-row @md:items-center @md:justify-between"
        >
          <p className="text-sm">{conflictQuestion(conflicts)}</p>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={undo.isPending}
              onClick={() => setConflicts(null)}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={undo.isPending} onClick={() => send(true)}>
              Set it back
            </Button>
          </div>
        </div>
      ) : null}
      {note ? (
        <p className="text-muted-foreground text-xs" role="status">
          {note}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The permission history, newest first: what changed, who changed it, and
 * when (spec `agent-permissions` D14). A login-off change says why it cannot
 * name who made it.
 *
 * Every change has an Undo, which is a new change of its own: mistakes should
 * be cheap. When something changed since, Undo asks before it overwrites it,
 * with the value it would write; a change that reached several agents undoes
 * what still matches and says what it left alone. A change already undone
 * says so instead of offering Undo twice.
 *
 * @param props - See {@link PermissionHistoryProps}.
 */
export function PermissionHistory({ agentId }: PermissionHistoryProps) {
  const { data, isPending, isError } = usePermissionHistory(agentId);
  if (isError) {
    return <p className="text-muted-foreground text-sm">Couldn’t read the history.</p>;
  }
  if (isPending) return <Skeleton className="h-12 w-full" />;
  const items = data?.items ?? [];
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">No permission changes yet.</p>;
  }
  return (
    <ul className="@container space-y-3" aria-label="Permission history">
      {items.map((item) => (
        <HistoryRow key={item.id} item={item} />
      ))}
    </ul>
  );
}
