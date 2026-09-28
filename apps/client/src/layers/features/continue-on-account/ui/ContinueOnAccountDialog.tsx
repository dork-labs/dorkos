import { useEffect, useId, useRef, useState } from 'react';
import type { ContinueOptionAccount } from '@dorkos/shared/account-usage';
import { useSessionId } from '@/layers/entities/session';
import type { SessionAccount } from '@/layers/features/status';
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
  STATUS_TONE_SURFACE,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useClaudeAccounts, useNow } from '@/layers/shared/model';
import {
  carryOverCopy,
  choiceKey,
  initialChoice,
  isOtherRuntime,
  isSelectable,
  isWaitOnly,
  keptOutLine,
  rowName,
  rowStatusText,
  splitByRuntime,
} from '../lib/continue-picker';
import { useContinueOptions } from '../model/use-continue-options';
import { useCancelAutoContinue, useContinueSession } from '../model/use-continue-session';

/** The runtime a session with no resolved runtime yet is read as. */
const DEFAULT_RUNTIME = 'claude-code';

/** What replaces the list when no account can be picked. */
const NOTHING_TO_OFFER = 'No other account can take this work right now.';

/** Props for {@link ContinueOnAccountDialog}. */
export interface ContinueOnAccountDialogProps {
  /** Whether the picker is open. */
  open: boolean;
  /** Told when the picker opens or closes. */
  onOpenChange: (open: boolean) => void;
  /** The limited session. */
  sessionId: string;
  /**
   * The session's account, from `useSessionAccount`: its runtime, its own
   * account, its limit (whose `accountId` names the account when the session's
   * own does not) and its flow item.
   */
  account: Pick<SessionAccount, 'runtime' | 'accountId' | 'limit' | 'trackerItem'>;
  /**
   * Stop an automatic move before listing anything (from `handing-off`), so
   * neither the countdown nor flow moves the work while the person chooses.
   */
  cancelAutoFirst?: boolean;
  /** A fixed moment to read reset days from (tests and the Dev Playground); else the clock. */
  now?: Date;
  /** Where focus goes when the picker closes; the dialog's own default otherwise. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** The message a failed request carries, for the inline alert. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Couldn't continue on that account. Try again.";
}

/** One account the person can pick: dot, name, the recommended pill, and its state. */
function AccountRow({
  row,
  value,
  name,
  status,
  selected,
}: {
  row: ContinueOptionAccount;
  value: string;
  name: string;
  status: string;
  selected: boolean;
}) {
  const selectable = isSelectable(row);
  return (
    <label
      data-slot="continue-account-row"
      data-eligible={row.eligible}
      className={cn(
        'flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm transition-colors duration-150',
        // The radio itself is visually hidden (the mockup marks the pick with the
        // row's border), so the row carries its keyboard focus ring.
        'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]',
        selected ? 'border-foreground ring-foreground ring-1 ring-inset' : 'border-border',
        selectable ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-not-allowed',
        // Not eligible reads dimmed whether or not it can still be picked (Q2).
        !row.eligible && 'opacity-60'
      )}
    >
      <RadioGroupItem value={value} disabled={!selectable} className="sr-only" />
      {/* The name is printed beside it, so the dot's own name would be said twice. */}
      <span aria-hidden className="inline-flex">
        <AccountDot color={row.color} name={name} />
      </span>
      {/* The name wins the width: it is what a person picks by. */}
      <span className="max-w-[55%] shrink-0 truncate font-medium">{name}</span>
      {row.badge === 'recommended' && (
        <span
          className={cn(
            STATUS_TONE_SURFACE.success,
            'border-status-success-border text-2xs shrink-0 rounded-full border px-1.5'
          )}
        >
          recommended
        </span>
      )}
      <span className="text-muted-foreground ml-auto min-w-0 pl-1 text-right text-xs">
        {status}
      </span>
    </label>
  );
}

/**
 * The "Continue on another account" picker (spec `claude-account-ui` §6.6):
 * the accounts the server offers, in its order, with how much each has left;
 * what carries over; and "Continue on <name>". Core UI that works without
 * flow; everything flow changes (the recommended pill, a reserved account,
 * accounts it keeps out, the checkpoint wording) arrives in the server's
 * answer.
 *
 * A session whose plan says it cannot carry over (it did not start here, or
 * its runtime cannot move accounts yet) lists nothing, so continue is never
 * called for it; the out-of-usage banner offers the wait instead.
 *
 * Controlled: the popover's action and the out-of-usage banner both open it.
 */
export function ContinueOnAccountDialog({
  open,
  onOpenChange,
  sessionId,
  account,
  cancelAutoFirst = false,
  now: fixedNow,
  onCloseAutoFocus,
}: ContinueOnAccountDialogProps) {
  const tick = useNow();
  const now = fixedNow ?? new Date(tick);
  const titleId = useId();
  const sessionRuntime = account.runtime ?? DEFAULT_RUNTIME;
  const { accounts: registered, nameFor } = useClaudeAccounts();
  const [, setSessionId] = useSessionId();

  const cancel = useCancelAutoContinue(sessionId);
  // One cancel per opening, even when an effect runs twice.
  const cancelStarted = useRef(false);
  const { mutate: cancelMutate, reset: cancelReset } = cancel;
  useEffect(() => {
    if (!open) {
      cancelStarted.current = false;
      cancelReset();
      return;
    }
    if (!cancelAutoFirst || cancelStarted.current) return;
    cancelStarted.current = true;
    cancelMutate();
  }, [open, cancelAutoFirst, cancelMutate, cancelReset]);

  // Nothing is listed until any automatic move has been stopped.
  const ready = open && (!cancelAutoFirst || cancel.isSuccess);
  const options = useContinueOptions(sessionId, ready);
  const move = useContinueSession(sessionId);
  const [choice, setChoice] = useState<string | null>(null);

  const close = () => {
    // A continue in flight keeps the picker open: closing would drop the
    // answer that opens the new session. The primary shows it is working.
    if (move.isPending) return;
    setChoice(null);
    move.reset();
    onOpenChange(false);
  };
  const handleOpenChange = (next: boolean) => (next ? onOpenChange(true) : close());

  const data = ready ? options.data : undefined;
  const list = data?.ranking;
  // A session that cannot carry over is offered nothing, whatever the list says.
  const rows = data && !isWaitOnly(data.plan) ? data.ranking.accounts : [];
  const anySelectable = rows.some(isSelectable);
  const selectedKey = choice ?? (list ? initialChoice(list, sessionRuntime) : null);
  const selectedRow = rows.find((row) => choiceKey(row, sessionRuntime) === selectedKey) ?? null;
  // A refetch can turn the picked account out while the picker is open.
  const canSubmit = selectedRow !== null && isSelectable(selectedRow);
  const nameOf = (row: ContinueOptionAccount) => rowName(row, sessionRuntime, nameFor);
  const { same, other } = splitByRuntime(rows, sessionRuntime);
  const copy = carryOverCopy(data?.advised === true, account.trackerItem !== null);

  // Accounts of this runtime the advisor left out. The session's own is never
  // listed, so without knowing which it is there is no honest line to show.
  const ownAccountId = account.accountId ?? account.limit?.accountId ?? null;
  const keptOut =
    data?.advised === true && sessionRuntime === DEFAULT_RUNTIME && ownAccountId !== null
      ? keptOutLine(
          registered
            .filter(
              (entry) =>
                entry.id && entry.id !== ownAccountId && !same.some((row) => row.id === entry.id)
            )
            .map((entry) => nameFor(entry.path))
        )
      : null;

  const submit = () => {
    if (!selectedRow || !isSelectable(selectedRow)) return;
    move.mutate(
      isOtherRuntime(selectedRow, sessionRuntime)
        ? { account: selectedRow.id, runtime: selectedRow.runtime }
        : { account: selectedRow.id },
      {
        onSuccess: (answer) => {
          close();
          // A flow run answers with no id: flow is moving it, and this
          // session's banner shows the handoff from the stream.
          if (answer.sessionId) setSessionId(answer.sessionId);
        },
      }
    );
  };

  const renderRow = (row: ContinueOptionAccount) => {
    const value = choiceKey(row, sessionRuntime);
    return (
      <AccountRow
        key={value}
        row={row}
        value={value}
        name={nameOf(row)}
        status={rowStatusText(row, now)}
        selected={value === selectedKey}
      />
    );
  };

  const failure = cancel.isError
    ? cancel.error
    : options.isError && ready
      ? options.error
      : move.isError
        ? move.error
        : null;
  const loading = open && !failure && (!ready || options.isPending);
  const showList = !loading && data !== undefined;

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent
        className="max-h-[85vh] !min-h-0"
        desktopProps={{ className: 'sm:max-w-[380px]' }}
        onCloseAutoFocus={onCloseAutoFocus}
        // The title carries its own id so the account list can be named by it too.
        aria-labelledby={titleId}
      >
        <ResponsiveDialogHeader className="shrink-0 text-left">
          <ResponsiveDialogTitle id={titleId} className="text-left">
            Continue on another account
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-left">
            {copy.subtitle}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="flex flex-col gap-3">
          {loading && (
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-11 rounded-lg" />
              <Skeleton className="h-11 rounded-lg" />
            </div>
          )}

          {showList &&
            (anySelectable ? (
              <RadioGroup
                aria-labelledby={titleId}
                value={selectedKey ?? ''}
                onValueChange={setChoice}
                className="min-w-0 grid-cols-1 gap-1.5"
              >
                {same.map(renderRow)}
                {/* The group caption Settings and the Flow tab use. */}
                {other.length > 0 && (
                  <div className="text-muted-foreground mt-2 text-xs font-semibold tracking-wide uppercase">
                    Other runtimes
                  </div>
                )}
                {other.map(renderRow)}
              </RadioGroup>
            ) : (
              <p className="text-muted-foreground text-sm">{NOTHING_TO_OFFER}</p>
            ))}

          {showList && keptOut && <p className="text-muted-foreground text-xs">{keptOut}</p>}

          {showList && (
            <ul className="text-muted-foreground list-disc pl-4 text-xs">
              <li>{copy.carries}</li>
              <li>{copy.doesnt}</li>
            </ul>
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
            disabled={!showList || !anySelectable || !canSubmit || move.isPending}
            aria-busy={move.isPending || undefined}
          >
            {move.isPending && <Spinner />}
            {selectedRow && showList && anySelectable
              ? `Continue on ${nameOf(selectedRow)}`
              : 'Continue'}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
