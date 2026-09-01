/**
 * Claude Code's declared `claude-accounts` settings section.
 *
 * @module features/settings/ui/runtimes/sections/ClaudeAccountsSection
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Trash2 } from 'lucide-react';
import { claudeAccountId } from '@dorkos/shared/config-schema';
import type { ServerConfig } from '@dorkos/shared/types';
import {
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
} from '@/layers/shared/ui';
import { configKeys, useConfig, useUpdateConfig } from '@/layers/entities/config';

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
  accounts?: { id: string; path: string; label: string | null }[];
};

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
 * @param accounts - The registered accounts as `GET /api/config` reported them.
 * @returns Rows shaped for `PATCH /api/config`.
 */
function toWritableAccounts(accounts: readonly Account[]): {
  id: string;
  path: string;
  label: string | null;
}[] {
  const taken = new Set(accounts.flatMap((account) => (account.id ? [account.id] : [])));
  return accounts.map((account) => {
    const id = account.id ?? claudeAccountId({ label: account.label, path: account.path, taken });
    taken.add(id);
    return { id, path: account.path, label: account.label };
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
  return (err instanceof Error && err.message) || 'Could not save that. Try again.';
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
            },
          ];
        })(),
      },
      () => {
        setNewPath('');
        setNewLabel('');
        setAdding(false);
      }
    );
  }

  function removeAccount(path: string) {
    const remaining = toWritableAccounts(accounts.filter((account) => account.path !== path));
    // Removing the account work is currently running on has to release it too,
    // or DorkOS would keep billing an account the operator just took off the
    // list. `defaultAccount` is a path, so nothing else can inherit the slot.
    const releasesActive = !inherited && resolvedAccount === path;
    write({ accounts: remaining, ...(releasesActive && { defaultAccount: null }) });
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
          disabled={updateConfig.isPending}
        />
      ))}

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
                Use the folder&apos;s full path, like <code>/Users/you/.claude2</code>. A path that
                starts with <code>~</code> will not work. Browse to pick the folder if you are not
                sure.
              </p>
            )}
          </div>
        </SettingRow>
      )}

      {writeError && (
        <p
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

/** One registered account: what it is called, where it lives, and whether DorkOS can read it. */
function AccountRow({
  account,
  accounts,
  isActive,
  onRemove,
  disabled,
}: {
  account: Account;
  accounts: Account[];
  isActive: boolean;
  onRemove: () => void;
  disabled: boolean;
}) {
  const name = claudeAccountName(account.path, accounts);
  return (
    <div className="flex items-start justify-between gap-4" data-testid="claude-account-row">
      <div className="min-w-0">
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
