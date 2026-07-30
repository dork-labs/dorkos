import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Trash2 } from 'lucide-react';
import type { ServerConfig } from '@dorkos/shared/types';
import { claudeAccountName, claudeAccountOptions, shortenHomePath } from '@/layers/shared/lib';
import {
  Button,
  DirectoryPicker,
  FieldCard,
  FieldCardContent,
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
import { useConfig, useUpdateConfig } from '@/layers/entities/config';

/**
 * Stands in for "no account chosen", which writes `activeAccount: null`. Radix
 * refuses an empty-string item value, so the absence needs a spelling.
 */
const DEFAULT_ACCOUNT = '__default__';

/** One registered account, as `GET /api/config` reports it. */
type Account = NonNullable<ServerConfig['claudeCode']>['accounts'][number];

/** The `runtimes.claudeCode` slice a write may carry. */
type ClaudeCodePatch = {
  activeAccount?: string | null;
  accounts?: { path: string; label: string | null }[];
};

/**
 * Turn a failed config write into one sentence a person can act on.
 *
 * The 403 case is the one that must never pass silently: both `operator-only`
 * leaves here refuse an agent, and under Require login they refuse anything
 * without an operator session cookie. The server already answers in plain words
 * ("Only a person can change those settings"), so this surfaces that rather than
 * inventing a second wording that could drift from the guard.
 */
function describeWriteFailure(err: unknown): string {
  const message = err instanceof Error && err.message ? err.message : '';
  const status = (err as { status?: number }).status;
  if (status === 403) {
    return message || 'Only a person signed in to DorkOS can change this setting.';
  }
  return message || 'Could not save that. Try again.';
}

/**
 * Which Claude Code account new work runs on, and the accounts DorkOS knows
 * about (spec `claude-code-accounts` D7).
 *
 * A sibling card in the Runtimes tab rather than part of the Claude Code runtime
 * card: that card is `entities/runtime`'s props-only `RuntimeSection`, and
 * entities cannot reach the config hooks this needs.
 *
 * Every write is one `PATCH /api/config`, and every failure is shown. Both leaves
 * are `operator-only`, so a refusal here is a real outcome, not an edge case.
 */
export function ClaudeAccountsCard() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();

  const [newPath, setNewPath] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const claudeCode = config?.claudeCode;
  const accounts: Account[] = claudeCode?.accounts ?? [];
  const resolvedAccount = claudeCode?.resolvedAccount;
  const inherited = claudeCode?.inherited ?? true;
  const activeValue = inherited || !resolvedAccount ? DEFAULT_ACCOUNT : resolvedAccount;

  const trimmedPath = newPath.trim();
  const isDuplicate = accounts.some((account) => account.path === trimmedPath);

  /**
   * Persist a `runtimes.claudeCode` change.
   *
   * Invalidates the `['config']` PREFIX, not the entity hook's exact key: the
   * settings tabs, `useFeatureEnabled`, and this card's own reader are split
   * across `['config']` and `['config','current']`, and the status-bar switcher
   * and sidebar badges have to move with this write.
   */
  function write(patch: ClaudeCodePatch, onDone?: () => void) {
    setWriteError(null);
    updateConfig.mutate(
      { runtimes: { claudeCode: patch } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['config'] });
          onDone?.();
        },
        onError: (err) => setWriteError(describeWriteFailure(err)),
      }
    );
  }

  function chooseAccount(value: string) {
    write({ activeAccount: value === DEFAULT_ACCOUNT ? null : value });
  }

  function addAccount() {
    if (!trimmedPath || isDuplicate) return;
    write(
      {
        accounts: [
          ...accounts.map((account) => ({ path: account.path, label: account.label })),
          { path: trimmedPath, label: newLabel.trim() || null },
        ],
      },
      () => {
        setNewPath('');
        setNewLabel('');
      }
    );
  }

  function removeAccount(path: string) {
    const remaining = accounts
      .filter((account) => account.path !== path)
      .map((account) => ({ path: account.path, label: account.label }));
    // Removing the account work is currently running on has to release it too,
    // or DorkOS would keep billing an account the operator just took off the
    // list. `activeAccount` is a path, so nothing else can inherit the slot.
    const releasesActive = !inherited && resolvedAccount === path;
    write({ accounts: remaining, ...(releasesActive && { activeAccount: null }) });
  }

  return (
    <FieldCard>
      <FieldCardContent>
        <SettingRow
          label="Claude Code account"
          description="New sessions run and bill on this account. Sessions you already started stay on the account that created them."
        >
          <Select value={activeValue} onValueChange={chooseAccount}>
            <SelectTrigger
              className="w-52"
              aria-label="Claude Code account"
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

        <SettingRow
          orientation="vertical"
          label="Add an account"
          description="Pick the folder Claude Code keeps the account in, then name it after the client it bills. DorkOS only reads the folder; it never signs you in or moves anything."
        >
          <div className="space-y-2">
            <PathInput
              aria-label="Account folder"
              placeholder="~/.claude2"
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
                className="h-8 flex-1"
              />
              <Button
                size="sm"
                onClick={addAccount}
                disabled={!trimmedPath || isDuplicate || updateConfig.isPending}
              >
                Add
              </Button>
            </div>
            {isDuplicate && (
              <p className="text-muted-foreground text-xs" data-testid="claude-account-duplicate">
                That folder is already on the list.
              </p>
            )}
          </div>
        </SettingRow>

        {writeError && (
          <p
            className="text-destructive flex items-start gap-1.5 text-xs"
            data-testid="claude-account-error"
          >
            <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
            <span>{writeError}</span>
          </p>
        )}
      </FieldCardContent>

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={setNewPath}
        initialPath={trimmedPath || null}
      />
    </FieldCard>
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
