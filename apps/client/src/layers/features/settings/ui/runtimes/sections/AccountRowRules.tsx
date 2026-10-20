/**
 * The rules under one Claude account's row in Settings → Runtimes: where it may
 * work ("Only for client-app" and "Limit to projects…") and, for a registered
 * account, whether DorkOS moves room agents to it on its own (Re-seat P0).
 *
 * Both writes are person-only routes; a refusal shows the server's sentence.
 *
 * @module features/settings/ui/runtimes/sections/AccountRowRules
 */

import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import { Button, Label, Switch } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import {
  LimitToProjectsDialog,
  messageOf,
  OnlyForLine,
  useInvalidateRules,
} from './AccountProjectRules';

/** One account's rules, as its row passes them. */
export interface AccountRule {
  /** The account's registry id, or `default` for Main. */
  accountId: string;
  /** The projects it is kept to, or null for any project. */
  onlyProjects: readonly ProjectRef[] | null;
  /**
   * Whether agents are kept off it in automatic moves. Absent for an account
   * with no registry row (Main standing alone), which has no switch.
   */
  noAutoMove?: boolean;
}

/**
 * Turn an account's automatic moves on or off, then refresh what the rules
 * feed: the config block and every account read.
 *
 * @param accountId - The account's registry id.
 */
export function useSetAccountNoAutoMove(accountId: string) {
  const transport = useTransport();
  const invalidate = useInvalidateRules();
  return useMutation({
    mutationFn: (noAutoMove: boolean) => transport.setAccountNoAutoMove(accountId, noAutoMove),
    onSuccess: invalidate,
  });
}

/**
 * "Move agents here automatically": on unless a person kept agents off the
 * account. A person can still move an agent there by hand either way.
 */
function AutoMoveSwitch({
  accountId,
  noAutoMove,
  disabled,
}: {
  accountId: string;
  noAutoMove: boolean;
  disabled: boolean;
}) {
  const id = useId();
  const save = useSetAccountNoAutoMove(accountId);
  // While a change is saving, show where it is going rather than where it was.
  const on = save.isPending ? save.variables === false : !noAutoMove;
  return (
    <div className="mt-1 space-y-1">
      <div className="flex items-start gap-2">
        <Switch
          id={id}
          size="sm"
          className="mt-0.5"
          checked={on}
          onCheckedChange={(next) => save.mutate(!next)}
          disabled={disabled || save.isPending}
          data-testid="claude-account-auto-move"
        />
        <div className="min-w-0">
          <Label htmlFor={id} className="text-xs font-normal">
            Move agents here automatically
          </Label>
          <p className="text-muted-foreground text-xs">
            When an agent runs out in a room, it can continue here.
          </p>
        </div>
      </div>
      {save.error && (
        <p role="alert" className="text-destructive flex items-start gap-1.5 text-xs">
          <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span>{messageOf(save.error)}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The rules under an account's row: the "Only for" line, the "Limit to
 * projects…" dialog, and the automatic-moves switch when the account has one.
 *
 * @param props.name - What the person calls the account.
 * @param props.rule - Its id and rules.
 * @param props.disabled - True while a write to the accounts is saving.
 */
export function AccountRowRules({
  name,
  rule,
  disabled,
}: {
  name: string;
  rule: AccountRule;
  disabled: boolean;
}) {
  const [limiting, setLimiting] = useState(false);
  return (
    <>
      <OnlyForLine onlyProjects={rule.onlyProjects} />
      <Button
        variant="link"
        size="sm"
        className="text-muted-foreground h-auto px-0 py-0.5 text-xs"
        onClick={() => setLimiting(true)}
        disabled={disabled}
      >
        Limit to projects…
      </Button>
      {/* Mounted only while open, so it starts from the rule as it is now. */}
      {limiting && (
        <LimitToProjectsDialog
          open
          onOpenChange={setLimiting}
          accountId={rule.accountId}
          accountName={name}
          current={rule.onlyProjects}
        />
      )}
      {rule.noAutoMove !== undefined && (
        <AutoMoveSwitch
          accountId={rule.accountId}
          noAutoMove={rule.noAutoMove}
          disabled={disabled}
        />
      )}
    </>
  );
}
