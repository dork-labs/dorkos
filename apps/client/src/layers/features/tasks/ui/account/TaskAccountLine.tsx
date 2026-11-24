/**
 * Which Claude account a task runs on, and whether a run may move (DOR-5097):
 * a run whose account is out of usage or signed out runs on another signed-in
 * account with room, unless the task is pinned to its own. The switch pins it.
 *
 * Shown for every Claude Code task: its own account, else its agent's, else the
 * default, so a pin is never invisible. A task on another runtime has no
 * account to show. Runs on DorkOS credits, and a remembered chat that already
 * started, never move, so they say so and offer the switch only to take a pin
 * off.
 *
 * @module features/tasks/ui/account/TaskAccountLine
 */
import { useId } from 'react';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Task } from '@dorkos/shared/types';
import { useUpdateTask } from '@/layers/entities/tasks';
import { CREDITS_ACCOUNT_LABEL } from '@/layers/shared/lib';
import { useClaudeAccounts } from '@/layers/shared/model';
import { Switch } from '@/layers/shared/ui';

/** Props for {@link TaskAccountLine}. */
export interface TaskAccountLineProps {
  /** The task whose account is shown. */
  task: Pick<Task, 'id' | 'account' | 'accountPinned' | 'runtime' | 'sticky' | 'lastRunAt'>;
  /** The task's agent, whose account and runtime it follows when it names none. */
  agent?: Pick<AgentManifest, 'account' | 'runtime'> | null;
}

/** The rule a task's runs follow, in a few words, or `null` when none applies. */
function ruleOf(pinned: boolean, onCredits: boolean, keepsChat: boolean): string | null {
  if (onCredits) return null;
  if (keepsChat) return 'Its remembered chat stays on this account.';
  return pinned
    ? 'Runs only here. A run won’t start if it’s out.'
    : 'Another account takes the run if this one is out.';
}

/**
 * The account line and its "This account only" switch, for the task's
 * expanded panel. Nothing for a task on another runtime.
 *
 * @param props - See {@link TaskAccountLineProps}.
 */
export function TaskAccountLine({ task, agent }: TaskAccountLineProps) {
  const switchId = useId();
  const updateTask = useUpdateTask();
  const { accounts, nameFor, resolvedAccount } = useClaudeAccounts();
  const runtime = task.runtime ?? agent?.runtime ?? null;
  if (runtime !== null && runtime !== 'claude-code') return null;

  const accountId = task.account ?? agent?.account ?? null;
  const onCredits = accountId === CREDITS_ACCOUNT_ID;
  const row = accounts.find((account) => accountId !== null && account.id === accountId);
  const defaultName = resolvedAccount ? nameFor(resolvedAccount) : 'the default account';
  const name = onCredits
    ? CREDITS_ACCOUNT_LABEL
    : row
      ? nameFor(row.path)
      : (accountId ?? defaultName);
  const whose = task.account !== null ? '' : agent?.account ? ' (its agent’s)' : ' (the default)';
  const pinned = task.accountPinned === true;
  const keepsChat = task.sticky && Boolean(task.lastRunAt);
  const rule = ruleOf(pinned, onCredits, keepsChat);
  // Credits and a started chat never move: the switch stays only to take a pin off.
  const offersSwitch = pinned || (!onCredits && !keepsChat);

  return (
    <div
      data-slot="task-account"
      className="text-muted-foreground mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"
    >
      <span className="min-w-0">
        <span className="text-foreground">
          Runs on {name}
          {whose}
        </span>
        {rule && (
          <span data-slot="task-account-rule">
            {' · '}
            {rule}
          </span>
        )}
      </span>
      {offersSwitch && (
        // A 44px target on a phone; compact from `sm`.
        <label
          htmlFor={switchId}
          className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 sm:min-h-0"
        >
          <Switch
            id={switchId}
            checked={pinned}
            disabled={updateTask.isPending}
            onCheckedChange={(checked) =>
              updateTask.mutate({ id: task.id, accountPinned: checked })
            }
          />
          This account only
        </label>
      )}
    </div>
  );
}
