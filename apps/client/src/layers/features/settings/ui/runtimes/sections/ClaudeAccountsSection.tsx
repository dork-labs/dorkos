/**
 * Claude Code's declared `claude-accounts` settings section.
 *
 * @module features/settings/ui/runtimes/sections/ClaudeAccountsSection
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Trash2 } from 'lucide-react';
import { claudeAccountId } from '@dorkos/shared/config-schema';
import {
  FLOW_FLEET_SETTINGS_TAB_ID,
  IMPLICIT_ACCOUNT_ID,
  type AccountUsage,
} from '@dorkos/shared/account-usage';
import type { ServerConfig } from '@dorkos/shared/types';
import {
  accountWindow,
  claudeAccountName,
  claudeAccountOptions,
  isAbsoluteAccountPath,
  shortenHomePath,
} from '@/layers/shared/lib';
import {
  Button,
  DirectoryPicker,
  Input,
  Label,
  PathInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
  UsageBar,
} from '@/layers/shared/ui';
import {
  useAccountUsage,
  useSettingsDeepLink,
  useSlotContributions,
  type AccountUsageView,
} from '@/layers/shared/model';
import { configKeys, useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useAccountIdentityGate } from '@/layers/entities/runtime';
import { AccountColorControl } from './AccountColorControl';
import { AccountUsageBars } from './AccountUsageBars';

/**
 * Stands in for "no account chosen", which writes `defaultAccount: null`. Radix
 * refuses an empty-string item value, so the absence needs a spelling.
 */
const DEFAULT_ACCOUNT = '__default__';

/** One registered account, as `GET /api/config` reports it. */
type Account = NonNullable<ServerConfig['claudeCode']>['accounts'][number];

/** The `runtimes.claudeCode` slice a write may carry. */
type ClaudeCodePatch = {
  defaultAccount?: string | null;
  accounts?: WritableAccount[];
  /**
   * The ids of the accounts this screen showed. The server removes only those
   * a write leaves out, so an account flow added after the screen loaded is
   * kept rather than read as removed.
   */
  accountsSeen?: string[];
};

/** The ids of the registered accounts this screen is showing. */
function shownIds(accounts: readonly Account[]): string[] {
  return accounts.flatMap((account) => (account.id ? [account.id] : []));
}

/** One registry row as a write carries it. */
type WritableAccount = { id: string; path: string; label: string | null; color: string | null };

/**
 * The registry rows as a WRITE carries them — ids included, because the id is
 * what an agent or a session references an account by and dropping it on a
 * rewrite would break every reference to that account.
 *
 * `id` is nullable on the wire for a row describing an unregistered root, and
 * absent on a registry the `'0.65.0'` migration has not reached yet; the
 * fallback mints one by the same rule the migration and the config schema use,
 * rather than writing an empty string.
 *
 * **Every id already in the list is reserved before any is minted.** Seeding the
 * taken set row by row inside the walk would let a row mint an id that a LATER
 * row already owns — two rows with one id, which the server now refuses outright
 * and which would otherwise make one account unreachable.
 *
 * **Each row carries its stored color**, `null` when it shows the default for
 * its position, so adding or removing an account never resets a color the
 * operator chose and never freezes a default into the file. The server merges
 * each row onto the stored one, so fields this screen does not know survive.
 *
 * @param accounts - The registered accounts as `GET /api/config` reported them.
 * @returns Rows shaped for `PATCH /api/config`.
 */
function toWritableAccounts(accounts: readonly Account[]): WritableAccount[] {
  const taken = new Set(accounts.flatMap((account) => (account.id ? [account.id] : [])));
  return accounts.map((account) => {
    const id = account.id ?? claudeAccountId({ label: account.label, path: account.path, taken });
    taken.add(id);
    return {
      id,
      path: account.path,
      label: account.label,
      color: account.colorIsDefault ? null : account.color,
    };
  });
}

/**
 * Turn a failed config write into one sentence a person can act on.
 *
 * The server's own wording is always preferred, and a refusal is the case that
 * matters: both `operator-only` leaves here reject an agent, and under Require
 * login they reject anything without an operator session cookie. The server
 * answers that in plain words ("Only a person can change those settings"), so
 * repeating it here is both correct and drift-proof — a second wording of our own
 * would go stale the day the guard's wording changes. The fallback covers a
 * transport that throws without a message at all.
 */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Couldn’t save that. Try again.';
}

/**
 * Which Claude Code account new work runs on, and the accounts DorkOS knows
 * about (spec `claude-code-accounts` D7).
 *
 * A boxed sub-section of the Claude Code runtime card, rendered through the
 * kind-keyed section registry because Claude Code's runtime declares it. It
 * owns its own hooks: `entities/runtime`'s card view is props-only and cannot
 * reach config, so the section — a feature — does the reading and writing.
 *
 * Every write is one `PATCH /api/config`, and every failure is shown. Both leaves
 * are `operator-only`, so a refusal here is a real outcome, not an edge case.
 */
export function ClaudeAccountsSection() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();

  const [newPath, setNewPath] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  // Every account-identity surface opens on this one gate (spec invariant 1):
  // the dots, the color control, the per-row bars and the Flow note.
  const identityGate = useAccountIdentityGate('claude-code');
  const usage = useAccountUsage('claude-code');
  const hasFlowTab = useSlotContributions('settings.tabs').some(
    (tab) => tab.id === FLOW_FLEET_SETTINGS_TAB_ID
  );

  const claudeCode = config?.claudeCode;
  const accounts: Account[] = claudeCode?.accounts ?? [];
  const resolvedAccount = claudeCode?.resolvedAccount;
  const inherited = claudeCode?.inherited ?? true;
  const activeValue = inherited || !resolvedAccount ? DEFAULT_ACCOUNT : resolvedAccount;

  const trimmedPath = newPath.trim();
  const isDuplicate = accounts.some((account) => account.path === trimmedPath);
  // The path is stored and read exactly as typed — nothing between this field and
  // the server expands a `~` — so a shorthand path would register a folder that is
  // not there. That is worse than it sounds: a junk entry still counts towards
  // "more than one account", which turns account badges on for every session row
  // when there is really only one account.
  const isNotAbsolute = trimmedPath.length > 0 && !isAbsoluteAccountPath(trimmedPath);
  const canAdd = trimmedPath.length > 0 && !isDuplicate && !isNotAbsolute;

  /**
   * Persist a `runtimes.claudeCode` change.
   *
   * Invalidates the `configKeys.all` PREFIX, not the entity hook's exact key:
   * the settings tabs, `useFeatureEnabled`, and this section's own reader are
   * split across `configKeys.all` and `configKeys.current()`, and the
   * status-bar switcher and sidebar badges have to move with this write. The
   * key comes from the entity's factory rather than a literal, so every writer
   * on this tab spells the prefix one way.
   */
  function write(patch: ClaudeCodePatch, onDone?: () => void) {
    setWriteError(null);
    updateConfig.mutate(
      { runtimes: { claudeCode: patch } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: configKeys.all });
          onDone?.();
        },
        onError: (err) => setWriteError(describeWriteFailure(err)),
      }
    );
  }

  function chooseAccount(value: string) {
    write({ defaultAccount: value === DEFAULT_ACCOUNT ? null : value });
  }

  function addAccount() {
    if (!canAdd) return;
    write(
      {
        accounts: (() => {
          const existing = toWritableAccounts(accounts);
          const label = newLabel.trim() || null;
          return [
            ...existing,
            {
              // The new account's stable reference, minted from the label (else
              // the directory's basename) and uniquified against the ids already
              // registered — the same rule the config migration backfills with.
              id: claudeAccountId({
                label,
                path: trimmedPath,
                taken: existing.map((account) => account.id),
              }),
              path: trimmedPath,
              label,
              color: null,
            },
          ];
        })(),
        accountsSeen: shownIds(accounts),
      },
      () => {
        setNewPath('');
        setNewLabel('');
        setAdding(false);
      }
    );
  }

  /** Store one account's color: a palette hex, or `null` to show its default again. */
  function chooseColor(path: string, color: string | null) {
    write({
      accounts: toWritableAccounts(accounts).map((row, i) =>
        accounts[i]!.path === path ? { ...row, color } : row
      ),
      accountsSeen: shownIds(accounts),
    });
  }

  function removeAccount(path: string) {
    const remaining = toWritableAccounts(accounts.filter((account) => account.path !== path));
    // Removing the account work is currently running on has to release it too,
    // or DorkOS would keep billing an account the operator just took off the
    // list. `defaultAccount` is a path, so nothing else can inherit the slot.
    const releasesActive = !inherited && resolvedAccount === path;
    write({
      accounts: remaining,
      accountsSeen: shownIds(accounts),
      ...(releasesActive && { defaultAccount: null }),
    });
  }

  return (
    <section
      className="bg-muted/30 space-y-3 rounded-lg border p-3"
      data-testid="claude-accounts-section"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Billing account
        </h4>
        {/* Quiet by design: adding an account is a rare, deliberate act, and the
            fields would otherwise crowd the card every time it is opened. */}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-auto px-1 py-0 text-xs"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
        >
          Add account
        </Button>
      </div>

      {!identityGate && <ClaudeUsageBlock accounts={accounts} usage={usage} />}

      {/* "Default", not "Account": this is the bottom of a three-rung ladder now
          (spec `billing-account-ladder`), and an agent or a single session can
          overrule it. Calling it "Account" would read as the answer when it is
          only the fallback. */}
      <SettingRow
        label="Default account"
        description="New sessions bill this account unless the agent or the session picks another."
      >
        <Select value={activeValue} onValueChange={chooseAccount}>
          <SelectTrigger
            className="w-52"
            aria-label="Default account"
            data-testid="claude-account-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_ACCOUNT}>
              {inherited && resolvedAccount
                ? `Default (${shortenHomePath(resolvedAccount)})`
                : 'Default'}
            </SelectItem>
            {claudeAccountOptions(accounts, inherited ? null : resolvedAccount).map((option) => (
              <SelectItem key={option.path} value={option.path}>
                {claudeAccountName(option.path, accounts)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      {accounts.map((account) => (
        <AccountRow
          key={account.path}
          account={account}
          accounts={accounts}
          isActive={!inherited && resolvedAccount === account.path}
          onRemove={() => removeAccount(account.path)}
          onChooseColor={(color) => chooseColor(account.path, color)}
          disabled={updateConfig.isPending}
          identity={
            identityGate
              ? {
                  usage:
                    (account.id ? usage.byId.get(account.id) : undefined) ??
                    usage.byPath.get(account.path),
                }
              : null
          }
        />
      ))}

      {identityGate && hasFlowTab && <FlowNote />}

      {adding && (
        <SettingRow
          orientation="vertical"
          label="Add an account"
          description="Pick the folder Claude Code keeps the account in, then name it after the client it bills. DorkOS only reads the folder; it never signs you in or moves anything."
        >
          <div className="space-y-2">
            <PathInput
              aria-label="Account folder"
              placeholder="/Users/you/.claude2"
              value={newPath}
              onChange={setNewPath}
              onBrowse={() => setPickerOpen(true)}
              browseTestId="browse-claude-account"
              data-testid="claude-account-path"
            />
            <div className="flex items-center gap-2">
              <Label htmlFor="claude-account-label" className="text-muted-foreground text-xs">
                Name
              </Label>
              <Input
                id="claude-account-label"
                placeholder="Acme Corp"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                // Matches the Button beside it exactly (`h-11 md:h-8`) rather
                // than Input's own default (`h-11 md:h-9`) or a flat `h-8` —
                // either would leave this row's two controls a few pixels
                // apart at one breakpoint or the other (DOR-771 review).
                className="h-11 flex-1 md:h-8"
              />
              <Button size="sm" onClick={addAccount} disabled={!canAdd || updateConfig.isPending}>
                Add
              </Button>
            </div>
            {isDuplicate && (
              <p className="text-muted-foreground text-xs" data-testid="claude-account-duplicate">
                That folder is already on the list.
              </p>
            )}
            {isNotAbsolute && (
              <p
                className="text-muted-foreground text-xs"
                data-testid="claude-account-not-absolute"
              >
                Use the folder’s full path, like <code>/Users/you/.claude2</code>. A path that
                starts with <code>~</code> will not work. Browse to pick the folder if you are not
                sure.
              </p>
            )}
          </div>
        </SettingRow>
      )}

      {writeError && (
        <p
          role="alert"
          className="text-destructive flex items-start gap-1.5 text-xs"
          data-testid="claude-account-error"
        >
          <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span>{writeError}</span>
        </p>
      )}

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={setNewPath}
        initialPath={trimmedPath || null}
      />
    </section>
  );
}

/**
 * Claude Code's usage while accounts are not told apart (0 or 1 registered):
 * the one account's 5-hour and weekly bars under "Billing account", labelled
 * with that account, or the implicit `default` account's when none is
 * registered. Nothing when that account has no reading.
 */
function ClaudeUsageBlock({
  accounts,
  usage,
}: {
  accounts: readonly Account[];
  usage: AccountUsageView;
}) {
  if (accounts.length > 1) return null;
  const only = accounts[0];
  const record: AccountUsage | undefined = only
    ? ((only.id ? usage.byId.get(only.id) : undefined) ?? usage.byPath.get(only.path))
    : usage.byId.get(IMPLICIT_ACCOUNT_ID);
  if (!record) return null;
  const name = only
    ? claudeAccountName(only.path, accounts)
    : (record.label ?? claudeAccountName(record.path, []));
  return <AccountUsageBars usage={record} name={name} />;
}

/**
 * The pointer to the Flow tab, shown only when accounts are told apart and the
 * Flow extension contributes its tab. The dialog is already open, so the link
 * switches tabs without closing it.
 */
function FlowNote() {
  const { setTab } = useSettingsDeepLink();
  return (
    <p className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs">
      Flow uses these accounts for your work. Choose how in{' '}
      <button
        type="button"
        onClick={() => setTab(FLOW_FLEET_SETTINGS_TAB_ID)}
        className="text-foreground font-semibold underline-offset-2 hover:underline"
      >
        Settings → Flow
      </button>
      .
    </p>
  );
}

/** One registered account: what it is called, where it lives, and whether DorkOS can read it. */
function AccountRow({
  account,
  accounts,
  isActive,
  onRemove,
  onChooseColor,
  disabled,
  identity,
}: {
  account: Account;
  accounts: Account[];
  isActive: boolean;
  onRemove: () => void;
  onChooseColor: (color: string | null) => void;
  disabled: boolean;
  /** The account's identity and usage, present only while the identity gate is open. */
  identity: { usage: AccountUsage | undefined } | null;
}) {
  const name = claudeAccountName(account.path, accounts);
  return (
    <div className="flex items-start gap-3" data-testid="claude-account-row">
      {identity && (
        <span className="mt-1 flex">
          <AccountColorControl
            name={name}
            color={account.color}
            colorIsDefault={account.colorIsDefault}
            onChoose={onChooseColor}
            disabled={disabled}
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {name}
          {isActive && <span className="text-muted-foreground ml-2 text-xs">in use</span>}
        </p>
        <p className="text-muted-foreground truncate font-mono text-xs" title={account.path}>
          {shortenHomePath(account.path)}
        </p>
        {!account.isAccountRoot && (
          <p
            className="text-muted-foreground mt-1 flex items-start gap-1.5 text-xs"
            data-testid="claude-account-not-ready"
          >
            <CircleAlert className="text-destructive mt-px size-3 shrink-0" aria-hidden />
            <span>
              This folder does not look like a Claude Code account yet, so DorkOS shows no sessions
              from it.
            </span>
          </p>
        )}
      </div>
      {identity && (
        <div className="w-36 shrink-0 space-y-1 pt-0.5">
          <UsageBar window={accountWindow(identity.usage, 'five_hour')} label="5h" compact />
          <UsageBar window={accountWindow(identity.usage, 'seven_day')} label="wk" compact />
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${name}`}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
