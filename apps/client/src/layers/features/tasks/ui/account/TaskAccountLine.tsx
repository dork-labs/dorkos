/**
 * Which Claude account a task runs on, and whether it may move (DOR-5097): a
 * run whose account is out of usage or signed out runs on another signed-in
 * account with room, unless the task is pinned to its own. The switch pins it.
 *
 * Shown only for a task that names an account: one that follows its agent has
 * no account of its own to pin.
 *
 * @module features/tasks/ui/account/TaskAccountLine
 */
import { useId } from 'react';
import type { Task } from '@dorkos/shared/types';
import { useUpdateTask } from '@/layers/entities/tasks';
import { useClaudeAccounts } from '@/layers/shared/model';
import { Switch } from '@/layers/shared/ui';

/** Props for {@link TaskAccountLine}. */
export interface TaskAccountLineProps {
  /** The task whose account is shown. */
  task: Pick<Task, 'id' | 'account' | 'accountPinned'>;
}

/**
 * The account line and its "This account only" switch, for the task's
 * expanded panel. Nothing for a task with no account of its own.
 *
 * @param props - See {@link TaskAccountLineProps}.
 */
export function TaskAccountLine({ task }: TaskAccountLineProps) {
  const switchId = useId();
  const updateTask = useUpdateTask();
  const { accounts, nameFor } = useClaudeAccounts();
  if (task.account === null) return null;
  const row = accounts.find((account) => account.id === task.account);
  const name = row ? nameFor(row.path) : task.account;
  const pinned = task.accountPinned === true;

  return (
    <div
      data-slot="task-account"
      className="text-muted-foreground mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"
    >
      <span className="min-w-0">
        <span className="text-foreground">Runs on {name}</span>
        <span data-slot="task-account-rule">
          {' · '}
          {pinned
            ? 'Runs only here. A run won’t start if it’s out.'
            : 'Another account takes the run if this one is out.'}
        </span>
      </span>
      {/* A 44px target on a phone; compact from `sm`. */}
      <label
        htmlFor={switchId}
        className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 sm:min-h-0"
      >
        <Switch
          id={switchId}
          checked={pinned}
          disabled={updateTask.isPending}
          onCheckedChange={(checked) => updateTask.mutate({ id: task.id, accountPinned: checked })}
        />
        This account only
      </label>
    </div>
  );
}
