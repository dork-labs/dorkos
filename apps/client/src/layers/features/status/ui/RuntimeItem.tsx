import { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  RUNTIME_DESCRIPTORS,
  RuntimeIdentity,
  RuntimeSetupDialog,
  getRuntimeDescriptor,
  isRuntimeReady,
  useRuntimeCapabilities,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { claudeAccountName } from '@/layers/shared/lib';
import { DEFAULT_ACCOUNT_VALUE, useAccountSwitch } from '../model/use-account-switch';
import { STATUS_ITEM_TRIGGER_CLASS } from '../lib/status-item-classes';

/** The runtime whose sessions belong to a Claude account. */
const CLAUDE_CODE = 'claude-code';

interface RuntimeItemProps {
  /**
   * Runtime type to display. The render site owns resolution: the session
   * row's server-authoritative `runtime` once the session has started, the
   * pending `?runtime=` selection or server default before that. Deliberately
   * NOT resolved here from a session id — the runtime-type endpoint
   * infers-on-miss (never 404s), so a forever-cached pre-bind fetch could pin
   * the wrong identity.
   */
  runtime: string;
  /**
   * The started session's resolved model id, paired with `runtime` to show
   * identity as runtime + model (spec decision 8). Nullish — pre-launch or a
   * runtime with no reported model — degrades the chip to the runtime alone.
   */
  model?: string | null;
  /** Called with the chosen runtime type when the user picks one pre-launch. */
  onChangeRuntime?: (type: string) => void;
  /**
   * Whether the runtime can still be chosen. False once the session has
   * started — runtime is immutable for a session's lifetime (ADR-0255).
   */
  canSelect: boolean;
  /**
   * The session this chip belongs to. The account pick is stored WITH it, so a
   * choice made on one conversation is never shown or sent on another.
   */
  sessionId: string;
  /**
   * Say it in as few pixels as possible — set below the status line's widest
   * tier. Drops the `· <model>` half, which the line's own model item already
   * spells out; the runtime name is what makes this item worth a slot.
   */
  compact?: boolean;
}

/** Setup-dialog state: closed, scoped to one runtime, or the unscoped overview. */
type SetupDialogState = { open: boolean; runtime?: string };

/**
 * Status bar chip showing the session's agent runtime.
 *
 * Selectable only in the pre-first-message state. Once a session has started
 * the chip is read-only with a tooltip explaining the immutability.
 *
 * Pre-launch, the dropdown renders whenever it has something actionable:
 * another registered runtime to pick, a registered runtime that needs setup,
 * or a known runtime this server has not registered (the "Add a runtime"
 * entry). This keeps "Add a runtime" reachable on single-runtime installs —
 * the chip at the moment of choosing where a session runs is the one place a
 * user discovers that DorkOS speaks more than one runtime (spec
 * additional-agent-runtimes, 4.2). Only when nothing is actionable (or the
 * capability map is still loading) does it stay a quiet identity chip.
 *
 * Runtimes that are not ready are never dead options: they render as a single
 * "Connect" entry that opens the Ready/Connect setup surface (one-click
 * provisioning for OpenCode; the terminal detail lives behind Advanced).
 *
 * On Claude Code the same menu carries the ACCOUNT THIS session bills to, once
 * more than one is registered — the choice belongs where a turn is initiated,
 * not only in Settings, because misattributed billing is the failure mode (spec
 * `claude-code-accounts` D6). It is a launch hint for this session alone and
 * writes no config; the server default lives in Settings → Runtimes and the
 * agent's account in its "Runs on" popover (spec `billing-account-ladder`).
 */
export function RuntimeItem({
  runtime,
  model,
  onChangeRuntime,
  canSelect,
  compact,
  sessionId,
}: RuntimeItemProps) {
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: requirements } = useRuntimeRequirements();
  const account = useAccountSwitch(sessionId);
  const [setupDialog, setSetupDialog] = useState<SetupDialogState>({ open: false });
  // Generated, not a literal: the status line renders one chip, but the tree can
  // hold more (the dev playground shows several side by side), and a duplicated
  // id would point every group at the first note.
  const accountNoteId = useId();

  const registeredTypes = Object.keys(capabilityMap?.capabilities ?? {});
  // Ready runtimes are selectable; unsatisfied ones get the setup affordance.
  // While requirements load, isRuntimeReady is optimistically true — the
  // picker never flashes a needs-setup state it cannot substantiate.
  const readyTypes = registeredTypes.filter((t) => isRuntimeReady(requirements, t));
  const needsSetupTypes = registeredTypes.filter((t) => !isRuntimeReady(requirements, t));
  // Known runtimes with published setup steps that this server has not
  // registered — the "Add a runtime" entry point.
  const hasAddableRuntime =
    capabilityMap !== undefined &&
    Object.values(RUNTIME_DESCRIPTORS).some((d) => d.setup && !registeredTypes.includes(d.type));

  // Actionable content gates the dropdown: another runtime to select, a
  // registered runtime needing setup, or an addable runtime to discover.
  //
  // Neither gate re-tests `canSelect`: the `if (!canSelect)` return below is
  // reached before any consumer of these, so a `canSelect &&` term here reads as
  // defensive but can never be the reason either one is false.
  const canChangeRuntime =
    !!onChangeRuntime &&
    (registeredTypes.length > 1 || needsSetupTypes.length > 0 || hasAddableRuntime);
  // Which Claude account THIS session bills to — the same pre-launch window the
  // runtime choice lives in, and for the same reason: once a session exists its
  // account is fixed to the one that created it (spec D3), so a switcher on a
  // started session would imply a move that is impossible. A started session's
  // account is legible on its sidebar row instead.
  //
  // Only with more than one account registered: below that every session runs on
  // the same account and the row would be a control with nothing to control.
  const canChangeAccount = runtime === CLAUDE_CODE && account.isMultiAccount;
  const selectable = canChangeRuntime || canChangeAccount;

  // Read-only identity chip. Deliberately not dimmed: unlike a temporarily
  // disabled control, "this session runs on OpenCode · qwen2.5-coder" is the
  // chip's steady state, so it renders at full strength like the other info
  // items. Identity is runtime + model via the shared RuntimeIdentity.
  //
  // Below the status line's widest tier the model half is redundant: the line's own
  // model item sits two slots away saying the same thing for ~90px.
  const shownModel = compact ? null : model;
  const chip = (
    <RuntimeIdentity runtime={runtime} model={shownModel} iconClassName="size-(--size-icon-xs)" />
  );

  if (!canSelect) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top">
          {"The runtime is set when a session starts and can't be changed afterward."}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Pre-launch but nothing actionable (every known runtime registered and
  // ready with no alternative to pick, or the list is still loading): quiet
  // identity chip, no dropdown affordance.
  if (!selectable) {
    return chip;
  }

  return (
    <>
      <ResponsiveDropdownMenu>
        <ResponsiveDropdownMenuTrigger asChild>
          <button className={STATUS_ITEM_TRIGGER_CLASS}>
            <RuntimeIdentity
              runtime={runtime}
              model={shownModel}
              iconClassName="size-(--size-icon-xs)"
            />
          </button>
        </ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
          {canChangeRuntime && (
            <>
              <ResponsiveDropdownMenuLabel>Runtime</ResponsiveDropdownMenuLabel>
              <ResponsiveDropdownMenuRadioGroup
                value={runtime}
                onValueChange={(v) => onChangeRuntime?.(v)}
              >
                {readyTypes.map((type) => {
                  const d = getRuntimeDescriptor(type);
                  return (
                    <ResponsiveDropdownMenuRadioItem key={type} value={type} icon={d.icon}>
                      {d.label}
                    </ResponsiveDropdownMenuRadioItem>
                  );
                })}
              </ResponsiveDropdownMenuRadioGroup>
              {needsSetupTypes.map((type) => {
                const d = getRuntimeDescriptor(type);
                return (
                  <ResponsiveDropdownMenuItem
                    key={type}
                    icon={d.icon}
                    description="Connect"
                    onSelect={() => setSetupDialog({ open: true, runtime: type })}
                  >
                    {d.label}
                  </ResponsiveDropdownMenuItem>
                );
              })}
              {hasAddableRuntime && (
                <>
                  <ResponsiveDropdownMenuSeparator />
                  <ResponsiveDropdownMenuItem
                    icon={Plus}
                    onSelect={() => setSetupDialog({ open: true })}
                  >
                    Add a runtime
                  </ResponsiveDropdownMenuItem>
                </>
              )}
            </>
          )}
          {canChangeAccount && (
            <>
              {canChangeRuntime && <ResponsiveDropdownMenuSeparator />}
              <ResponsiveDropdownMenuLabel>Account</ResponsiveDropdownMenuLabel>
              {/* Said before the options, not after: the scope of the choice is
                  what a person needs to know to make it. Picking here used to
                  rewrite the server default, so spelling out that it no longer
                  does is the whole point of the line. It is the group's
                  DESCRIPTION, not a loose paragraph — a caveat about money that
                  only sighted users receive is not a caveat. */}
              <p
                id={accountNoteId}
                className="text-muted-foreground text-2xs px-2 pb-1 leading-snug"
                data-testid="account-scope-note"
              >
                This session only. Locked once the first message sends.
              </p>
              <ResponsiveDropdownMenuRadioGroup
                value={account.selectedValue}
                onValueChange={account.choose}
                aria-describedby={accountNoteId}
              >
                <ResponsiveDropdownMenuRadioItem value={DEFAULT_ACCOUNT_VALUE}>
                  {account.defaultLabel ? `Default — ${account.defaultLabel}` : 'Default'}
                </ResponsiveDropdownMenuRadioItem>
                {account.accounts.map((entry) => (
                  <ResponsiveDropdownMenuRadioItem
                    key={entry.id}
                    // The registry id, never the path: an account reference is by
                    // id everywhere it travels (ADR 260821-205324), and the server
                    // resolves the hint against `accounts[].id`.
                    value={entry.id}
                    // The server already checked this folder and could not find an
                    // account in it, so say so here as plainly as the settings
                    // card does on its row. Still selectable, not disabled: an
                    // account authenticated a minute ago has no `projects/`
                    // either (spec §9), and choosing it is how the first session
                    // gets there.
                    description={
                      entry.isAccountRoot === false
                        ? 'Does not look like an account folder yet'
                        : undefined
                    }
                  >
                    {claudeAccountName(entry.path, account.accounts)}
                  </ResponsiveDropdownMenuRadioItem>
                ))}
              </ResponsiveDropdownMenuRadioGroup>
            </>
          )}
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>
      <RuntimeSetupDialog
        runtime={setupDialog.runtime}
        open={setupDialog.open}
        onOpenChange={(open) => setSetupDialog((s) => ({ ...s, open }))}
        renderConnect={renderRuntimeConnect}
        showConnectSuccess
        onRuntimeReady={(type) => {
          // Connect just succeeded — hand off the runtime: select the one it was
          // opened for (sets pendingRuntime + ?runtime=) so the chip reflects it
          // and the first send binds to it. The dialog now stays open on its
          // success panel; the person closes it with Done (no silent auto-close).
          onChangeRuntime?.(type);
        }}
      />
    </>
  );
}
