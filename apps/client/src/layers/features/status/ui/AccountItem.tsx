import { useId, useState, type ComponentPropsWithRef } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { useModels } from '@/layers/entities/session';
import {
  AccountDot,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuTrigger,
  STATUS_TONE_SURFACE,
  UsageMiniBars,
  usageMiniBarsLabel,
} from '@/layers/shared/ui';
import { accountWindow, cn, type ChipState } from '@/layers/shared/lib';
import { useAccountUsage, useClaudeAccounts, useNow } from '@/layers/shared/model';
import { DEFAULT_ACCOUNT_VALUE, useAccountSwitch } from '../model/use-account-switch';
import type { SessionAccount } from '../model/use-session-account';
import { accountChipText, chipToneFor } from '../lib/account-chip';
import { STATUS_ITEM_TRIGGER_CLASS } from '../lib/status-item-classes';
import { AccountPopover } from './AccountPopover';

/** The tinted surface and border each chip tone wears. */
const TONE_CLASSES = {
  warning: cn(
    STATUS_TONE_SURFACE.warning,
    'border-status-warning-border hover:text-status-warning-fg'
  ),
  error: cn(STATUS_TONE_SURFACE.error, 'border-status-error-border hover:text-status-error-fg'),
} as const;

/** Props for {@link AccountTrigger}. */
export interface AccountTriggerProps extends Omit<ComponentPropsWithRef<'button'>, 'color'> {
  /** The account's name, always printed. */
  name: string;
  /** The account's color, or `null` when unknown (no dot is drawn). */
  color: string | null;
  /** How the chip reads the account. */
  chipState: ChipState;
  /** The words after the name (`91% of week`), or `null` to draw the usage bars. */
  stateText: string | null;
  /** The account's usage, for the bars. */
  usage: AccountUsage | null;
  /** Draw a chevron, for the pre-launch picker. */
  chevron?: boolean;
}

/**
 * The account chip itself: the account's dot and name, then either its two
 * usage bars or, when there is news, what happened in words (`· 91% of week`,
 * `· out until Tue 3pm`). Amber for near and model-out, red for out.
 *
 * A button whose accessible name carries the name and the state, so a screen
 * reader hears "Acct 4, out until Tue 3pm" and color is never the only signal.
 * The name truncates first at narrow widths; the state words never do.
 */
export function AccountTrigger({
  name,
  color,
  chipState,
  stateText,
  usage,
  chevron = false,
  className,
  ref,
  ...props
}: AccountTriggerProps) {
  const fiveHour = accountWindow(usage, 'five_hour');
  const week = accountWindow(usage, 'seven_day');
  const tone = chipToneFor(chipState);
  return (
    <button
      ref={ref}
      type="button"
      data-slot="account-chip"
      data-state-tone={tone ?? 'neutral'}
      aria-label={`${name}, ${stateText ?? usageMiniBarsLabel(fiveHour, week)}`}
      className={cn(
        STATUS_ITEM_TRIGGER_CLASS,
        'items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5',
        tone && TONE_CLASSES[tone],
        className
      )}
      {...props}
    >
      {/* The name is printed beside it, so the dot's own name would be said twice. */}
      {color && (
        <span aria-hidden className="inline-flex">
          <AccountDot color={color} name={name} />
        </span>
      )}
      <span className="min-w-0 truncate">{name}</span>
      {stateText ? (
        <span className="shrink-0 whitespace-nowrap">· {stateText}</span>
      ) : (
        <UsageMiniBars fiveHour={fiveHour} week={week} />
      )}
      {chevron && <ChevronDown aria-hidden className="size-(--size-icon-xs) shrink-0 opacity-60" />}
    </button>
  );
}

/** Props for {@link AccountMenuRow}. */
export interface AccountMenuRowProps {
  /** What the row says: the account's name, or `Default: <name>`. */
  label: string;
  /** The account's color, or `null` when unknown. */
  color: string | null;
  /** The account's usage, for the bars. */
  usage: AccountUsage | null;
}

/** One row of the pre-launch account menu: dot, name, and the account's usage bars. */
export function AccountMenuRow({ label, color, usage }: AccountMenuRowProps) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {color && (
        <span aria-hidden className="inline-flex">
          <AccountDot color={color} name={label} />
        </span>
      )}
      <span className="min-w-0 truncate">{label}</span>
      <UsageMiniBars
        className="ml-auto"
        fiveHour={accountWindow(usage, 'five_hour')}
        week={accountWindow(usage, 'seven_day')}
      />
    </span>
  );
}

/**
 * The pre-launch account picker: the chip with a chevron, over a menu of the
 * registered accounts. Choosing holds the account for this session only, as a
 * hint the first message spends (`useAccountSwitch`); it writes no config.
 */
function AccountPicker({
  sessionId,
  account,
  name,
  stateText,
}: {
  sessionId: string;
  account: SessionAccount;
  name: string;
  stateText: string | null;
}) {
  const accountSwitch = useAccountSwitch(sessionId);
  const { nameFor } = useClaudeAccounts();
  // Cache only: the chip's own read already fetched the runtime's usage when
  // the seed lacked it, and that answer covers every account.
  const { byId, byPath } = useAccountUsage(account.runtime);
  const noteId = useId();
  const usageOf = (id: string | null, path: string | undefined) =>
    (id ? byId.get(id) : undefined) ?? (path ? byPath.get(path) : undefined) ?? null;

  const defaultEntry = accountSwitch.accounts.find(
    (entry) => entry.path === accountSwitch.defaultPath
  );
  // The account "Default" resolves to leads the list, so the row a person is
  // most likely to want is first; the rest keep the order they were registered in.
  const ordered = defaultEntry
    ? [defaultEntry, ...accountSwitch.accounts.filter((entry) => entry !== defaultEntry)]
    : accountSwitch.accounts;

  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <AccountTrigger
          name={name}
          color={account.color}
          chipState={account.chipState}
          stateText={stateText}
          usage={account.usage}
          chevron
        />
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="start" className="w-64">
        <ResponsiveDropdownMenuLabel>Account</ResponsiveDropdownMenuLabel>
        {/* The group's description, not a loose paragraph: a caveat about
            money that only sighted users receive is not a caveat. */}
        <p
          id={noteId}
          className="text-muted-foreground text-2xs px-2 pb-1 leading-snug"
          data-testid="account-scope-note"
        >
          This session only. Locked once the first message sends.
        </p>
        <ResponsiveDropdownMenuRadioGroup
          value={accountSwitch.selectedValue}
          onValueChange={accountSwitch.choose}
          aria-describedby={noteId}
        >
          <ResponsiveDropdownMenuRadioItem value={DEFAULT_ACCOUNT_VALUE}>
            <AccountMenuRow
              label={
                accountSwitch.defaultLabel ? `Default: ${accountSwitch.defaultLabel}` : 'Default'
              }
              color={defaultEntry?.color ?? null}
              usage={defaultEntry ? usageOf(defaultEntry.id, defaultEntry.path) : null}
            />
          </ResponsiveDropdownMenuRadioItem>
          {ordered.map((entry) => (
            <ResponsiveDropdownMenuRadioItem
              key={entry.id}
              // The registry id, never the path: the server resolves the hint
              // against `accounts[].id` (ADR 260821-205324).
              value={entry.id}
              // Still selectable: an account signed in a minute ago has no
              // `projects/` yet, and choosing it is how the first session gets there.
              description={
                entry.isAccountRoot === false
                  ? 'Does not look like an account folder yet'
                  : undefined
              }
            >
              <AccountMenuRow
                label={nameFor(entry.path)}
                color={entry.color}
                usage={usageOf(entry.id, entry.path)}
              />
            </ResponsiveDropdownMenuRadioItem>
          ))}
        </ResponsiveDropdownMenuRadioGroup>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}

/** Props for {@link AccountItem}. */
export interface AccountItemProps {
  /** The session the chip belongs to; a pre-launch pick is stored with it. */
  sessionId: string;
  /** The session's account, from `useSessionAccount`. */
  account: SessionAccount;
  /** Opens the "continue on another account" picker; the popover offers it only when set. */
  onContinue?: () => void;
  /** A fixed moment to read reset times from (tests and the Dev Playground); else the clock. */
  now?: Date;
  /** Controlled popover state, for the Dev Playground. */
  open?: boolean;
  /** Told when the popover opens or closes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * The status-bar account chip (spec `claude-account-ui` §6.1): which account
 * this session spends and how much is left, with a popover of every window.
 * Before the first message it is the account picker instead.
 *
 * Renders nothing unless the account identity gate is open (two or more
 * accounts on a runtime that tells them apart). Updates from the
 * `account_usage` event and the session stream with no polling; the clock only
 * re-renders the words, once a minute.
 */
export function AccountItem({
  sessionId,
  account,
  onContinue,
  now: fixedNow,
  open,
  onOpenChange,
}: AccountItemProps) {
  const tick = useNow();
  const now = fixedNow ?? new Date(tick);
  // The same query the status bar's model item reads, so this is a cache hit.
  const { data: models } = useModels({
    sessionId: sessionId || undefined,
    runtime: account.runtime ?? undefined,
  });
  const [internalOpen, setInternalOpen] = useState(false);

  if (!account.visible) return null;

  const stateText = accountChipText({
    chipState: account.chipState,
    usage: account.usage,
    limit: account.limit,
    models,
    now,
  });

  if (account.pending) {
    // Before launch the chip is the only account picker, so it always renders:
    // named by the pick, else the account the ladder resolves to, else the
    // menu's own "Default" while that answer is unknown (the agent read may be
    // in flight or have failed).
    return (
      <AccountPicker
        sessionId={sessionId}
        account={account}
        name={account.name ?? 'Default'}
        stateText={stateText}
      />
    );
  }

  // After launch, an account nobody can name renders nothing: saying nothing
  // beats inventing a label for money that is being spent somewhere.
  if (account.name === null) return null;

  const isOpen = open ?? internalOpen;
  return (
    <AccountPopover
      account={account}
      name={account.name}
      onContinue={onContinue}
      now={now}
      open={isOpen}
      onOpenChange={(next) => {
        setInternalOpen(next);
        onOpenChange?.(next);
      }}
    >
      <AccountTrigger
        name={account.name}
        color={account.color}
        chipState={account.chipState}
        stateText={stateText}
        usage={account.usage}
      />
    </AccountPopover>
  );
}
