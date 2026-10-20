/**
 * "Continue on another account…" for an agent in a room or DM: pick a Claude
 * account and its seat here moves there, with the same look as the chat's own
 * picker (`ContinueOnAccountDialog`). Its next turn starts fresh on that
 * account with a summary of where it was; the room says so in one line.
 *
 * @module features/reseat-agent/ui/ReseatAgentDialog
 */
import { useId, useState } from 'react';
import type { ReseatOptions } from '@dorkos/shared/room-schemas';
import {
  AccountDot,
  Button,
  RadioGroup,
  RadioGroupItem,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Skeleton,
  Spinner,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useReseatAgent, useReseatOptions } from '../model/use-reseat-agent';

type Account = ReseatOptions['accounts'][number];

/** Shown when no account can take the agent now. */
export const NOTHING_LEFT = 'No other account has usage left';

/** What an account is called: its label, else its id. */
function nameOf(account: { id: string; label: string | null }): string {
  return account.label ?? account.id;
}

/** The message a failed request carries, for the inline alert. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Couldn’t move it to that account. Try again.';
}

/** Props for {@link ReseatAgentDialog}. */
export interface ReseatAgentDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to open or close it. */
  onOpenChange: (open: boolean) => void;
  /** The room or DM. */
  roomId: string;
  /** The agent whose seat moves. */
  authorId: string;
  /** The agent's name, as the room shows it. */
  agentName: string;
}

/** One account the person can pick: dot, name, and why it can't take the agent. */
function AccountRow({ account, selected }: { account: Account; selected: boolean }) {
  return (
    <label
      data-slot="reseat-account-row"
      data-eligible={account.eligible}
      className={cn(
        'flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm transition-colors duration-150',
        'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-[3px]',
        selected ? 'border-foreground ring-foreground ring-1 ring-inset' : 'border-border',
        account.eligible ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-not-allowed opacity-60'
      )}
    >
      <RadioGroupItem value={account.id} disabled={!account.eligible} className="sr-only" />
      <span aria-hidden className="inline-flex">
        <AccountDot color={account.color} name={nameOf(account)} />
      </span>
      <span className="max-w-[55%] shrink-0 truncate font-medium">{nameOf(account)}</span>
      {!account.eligible && (
        <span className="text-muted-foreground ml-auto min-w-0 pl-1 text-right text-xs">
          {account.reason}
        </span>
      )}
    </label>
  );
}

/**
 * Pick the account an agent's seat in a room moves to.
 *
 * @param props - See {@link ReseatAgentDialogProps}.
 */
export function ReseatAgentDialog({
  open,
  onOpenChange,
  roomId,
  authorId,
  agentName,
}: ReseatAgentDialogProps) {
  const titleId = useId();
  const options = useReseatOptions(roomId, authorId, open);
  const move = useReseatAgent(roomId, authorId);
  const [choice, setChoice] = useState<string | null>(null);

  const accounts = options.data?.accounts ?? [];
  const eligible = accounts.filter((account) => account.eligible);
  // The server ranks best first, so the first one that can take it is the pick.
  const selected = eligible.find((account) => account.id === choice) ?? eligible[0] ?? null;
  const loading = open && options.isPending;
  const failure = options.isError ? options.error : move.isError ? move.error : null;
  const current = options.data?.current ?? null;

  const close = () => {
    move.reset();
    setChoice(null);
    onOpenChange(false);
  };

  const submit = () => {
    if (!selected) return;
    move.mutate(selected.id, { onSuccess: close });
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <ResponsiveDialogContent
        className="max-h-[85vh] !min-h-0"
        desktopProps={{ className: 'sm:max-w-[380px]' }}
        aria-labelledby={titleId}
      >
        <ResponsiveDialogHeader className="shrink-0 text-left">
          <ResponsiveDialogTitle id={titleId} className="text-left">
            Continue on another account
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-left">
            {current
              ? `${agentName} is on ${nameOf(current)}. Pick where it continues.`
              : `Pick where ${agentName} continues.`}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="flex flex-col gap-3">
          {loading && (
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-11 rounded-lg" />
              <Skeleton className="h-11 rounded-lg" />
            </div>
          )}

          {!loading && options.data !== undefined && eligible.length > 0 && (
            <RadioGroup
              aria-labelledby={titleId}
              value={selected?.id ?? ''}
              onValueChange={setChoice}
              className="min-w-0 grid-cols-1 gap-1.5"
            >
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  selected={account.id === selected?.id}
                />
              ))}
            </RadioGroup>
          )}

          {!loading && options.data !== undefined && eligible.length === 0 && (
            <p className="text-muted-foreground text-sm">{NOTHING_LEFT}</p>
          )}

          {!loading && options.data !== undefined && (
            <p className="text-muted-foreground text-xs">
              Its next turn starts fresh there, with a summary of where it was.
            </p>
          )}

          {failure !== null && (
            <p role="alert" className="text-destructive text-sm">
              {messageOf(failure)}
            </p>
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter className="shrink-0">
          <Button variant="outline" onClick={close} disabled={move.isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={selected === null || move.isPending}
            aria-busy={move.isPending || undefined}
          >
            {move.isPending && <Spinner />}
            {selected ? `Continue on ${nameOf(selected)}` : 'Continue'}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
