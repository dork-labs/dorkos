import { useCallback, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import type { AgentManifest, AgentManifestUpdate } from '@dorkos/shared/mesh-schemas';
import type { EffortLevel } from '@dorkos/shared/types';
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import {
  claudeAccountName,
  cn,
  describeAgentExecution,
  effortLabel,
  knownModelsFrom,
  shortenHomePath,
  type KnownAccount,
} from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import {
  ProvenanceChip,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  UnverifiedCatalogNotice,
} from '@/layers/shared/ui';
import { useConfig } from '@/layers/entities/config';
import { useUpdateAgent as useUpdateMeshAgent } from '@/layers/entities/mesh';
import {
  getRuntimeDescriptor,
  settingsForRuntime,
  useRuntimeCapabilities,
} from '@/layers/entities/runtime';
import { useModels } from '@/layers/entities/session';
import { agentKeys } from '../api/queries';

/** The field-label style every cell in the Runs on picker's metadata grid uses. */
const LABEL_CLASS = 'text-muted-foreground text-3xs font-medium tracking-wider uppercase';

/** One option in a row's picker. */
interface RowOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * One execution setting: its label, where its value came from, and the control
 * that changes it.
 *
 * Desktop opens a popover, a phone pushes the vaul drawer the app already uses
 * everywhere, and both are the same component because they are the same choice
 * (spec `execution-defaults` §6). The inherit line sits at the FOOT of the list
 * rather than the top: on a phone the foot is where the thumb is, and it is the
 * action a person arrives at after reading the options, not before.
 */
function ExecutionRow({
  label,
  valueLabel,
  options,
  selected,
  isSetHere,
  serverDefault,
  warning,
  onSelect,
  onInherit,
  testId,
  showHeader = true,
  className,
  describedBy,
}: {
  label: string;
  valueLabel: string;
  options: RowOption[];
  selected: string | null;
  isSetHere: boolean;
  serverDefault: string | null;
  warning: string | null;
  onSelect: (value: string) => void;
  onInherit: () => void;
  testId: string;
  /** Extra classes for the row's wrapper — how a caller spans it across the grid. */
  className?: string;
  /**
   * Id of an element that qualifies this row's value, put on the trigger as
   * `aria-describedby`. The caller draws that element beneath the row, so
   * without this a screen-reader user reaching the control never hears it.
   */
  describedBy?: string;
  /**
   * Draw the label and chip. Off when the caller already drew them because it
   * has to choose between this row and a truth sentence, and the label belongs
   * to the choice rather than to either outcome.
   */
  showHeader?: boolean;
}) {
  const isMobile = useIsMobile();
  // Controlled so a choice can CLOSE it. Radix keeps an uncontrolled popover
  // open when the click lands on a plain button rather than a menu item, which
  // left the list sitting over the row it had just changed — the row underneath
  // updated, the panel covering it did not, and the whole point of the row is
  // seeing what it now says.
  const [open, setOpen] = useState(false);

  return (
    <div className={cn('space-y-1', className)}>
      {showHeader && (
        <div className="flex items-center gap-1.5">
          <span className={LABEL_CLASS}>{label}</span>
          {/* Provenance is a chip on a wide screen and the value's own color on a
            narrow one: a phone row has no width for a second piece of text, and
            a chip that wraps under its label reads as a separate control. */}
          {!isMobile && (
            <ProvenanceChip
              isSetHere={isSetHere}
              serverDefault={serverDefault}
              warning={warning}
              onUseServerDefault={onInherit}
              data-testid={`${testId}-chip`}
            />
          )}
        </div>
      )}
      <ResponsivePopover open={open} onOpenChange={setOpen}>
        <ResponsivePopoverTrigger asChild>
          <button
            type="button"
            className="border-input hover:bg-accent flex h-8 w-full items-center gap-1 rounded-md border px-2 text-sm transition-colors"
            {...(describedBy ? { 'aria-describedby': describedBy } : {})}
            data-testid={testId}
          >
            <span
              className={cn(
                'truncate',
                warning
                  ? 'text-amber-700 dark:text-amber-400'
                  : isSetHere
                    ? 'md:text-foreground text-amber-700 dark:text-amber-400'
                    : 'md:text-foreground text-emerald-700 dark:text-emerald-400'
              )}
            >
              {valueLabel}
            </span>
            <ChevronDown className="text-muted-foreground ml-auto size-3.5 shrink-0" />
          </button>
        </ResponsivePopoverTrigger>
        <ResponsivePopoverContent className="w-64 p-1" align="start">
          <ResponsivePopoverTitle>{label}</ResponsivePopoverTitle>
          <div className="max-h-72 overflow-y-auto">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                data-testid={`${testId}-option-${option.value}`}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'hover:bg-accent w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  option.value === selected && 'bg-accent'
                )}
              >
                {option.label}
                {option.hint && (
                  <span className="text-muted-foreground block text-xs">{option.hint}</span>
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              onInherit();
              setOpen(false);
            }}
            className="hover:bg-accent border-border text-muted-foreground mt-1 w-full border-t px-2 py-2 text-left text-xs transition-colors"
            data-testid={`${testId}-inherit`}
          >
            {serverDefault
              ? `Using server default: ${serverDefault} — tap to restore`
              : 'Use server default — the runtime picks'}
          </button>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    </div>
  );
}

/** What {@link AgentExecutionRows} needs: the agent, and somewhere to put a change. */
export interface AgentExecutionRowsProps {
  /** The agent being configured. */
  agent: AgentManifest;
  /**
   * Persist a change to Model or Effort. `null` on either key means "go back to
   * inheriting", which is exactly what the wire's `null` means.
   *
   * **The Account row does not come through here** (DOR-1736). Both of these
   * are `agent-writable`, so the agent self-edit route a caller wires this to
   * accepts them; `account` is `operator-only` and that route refuses it. The
   * row writes itself, through `PATCH /api/mesh/agents/:id` — see the callback
   * inside {@link AgentExecutionRows}.
   */
  onUpdate: (updates: AgentManifestUpdate) => void;
  /**
   * Classes for the two-column grid the rows sit in.
   *
   * Pass `grid-cols-1` where the surface is narrow: at a popover's width the
   * two provenance chips collide into each other rather than sitting beside
   * their labels.
   */
  className?: string;
}

/**
 * An agent's Model, Effort and Account rows — the settings that join the Runtime
 * choice beside them (spec `execution-defaults` §2, `billing-account-ladder` §2).
 *
 * Three rows rather than one summary row opening a shared popover: each setting
 * has its own provenance, and provenance is the thing worth seeing at a glance.
 * They read the same data the status-bar picker reads (`GET /api/models?runtime=`,
 * `ModelOption.supportsEffort`) — shared source, per-surface composition — so a
 * model the picker offers is a model this row offers.
 *
 * Effort is the row that has to tell the truth in three different ways: an
 * inline choice where the runtime and model can honor it, a plain sentence where
 * the runtime has none at all, and a plain sentence where the model does not
 * take one. None of the three is a hidden row (§3.4).
 *
 * Account is the one row that IS sometimes hidden, and for the opposite reason:
 * a runtime that has no such thing as an account, or a machine with only one, is
 * not a setting waiting to be explained — it is not a setting at all. It appears
 * the moment there is a choice, or the moment this agent has already made one.
 * It is also the one row that saves ITSELF rather than through `onUpdate`,
 * because billing is operator-only and the self-edit route refuses it
 * (DOR-1736) — see `writeAccount` below.
 *
 * @param props - See {@link AgentExecutionRowsProps}.
 */
export function AgentExecutionRows({ agent, onUpdate, className }: AgentExecutionRowsProps) {
  const isMobile = useIsMobile();
  const { data: config } = useConfig();
  const { data: capabilityMap, isPending: capabilitiesPending } = useRuntimeCapabilities();
  const defaultRuntime = config?.executionDefaults?.runtime ?? 'claude-code';
  const runtime = agent.runtime ?? defaultRuntime;
  const serverForRuntime = config?.executionDefaults?.perRuntime.find((e) => e.runtime === runtime);
  const { data: models } = useModels({ runtime });

  // `!= null`, not `!== undefined`, everywhere provenance is asked: an in-flight
  // optimistic update carries the wire's `null` for "go back to inheriting", and
  // reading that as a value made a reset click show "set here" and an amber
  // "no longer offers null." for the length of one round-trip.
  const modelIsSetHere = agent.model != null;
  const effortIsSetHere = agent.effort != null;

  const serverDefaultModel = serverForRuntime?.model ?? null;
  const effectiveModel = agent.model ?? serverDefaultModel;
  const selectedModel = effectiveModel
    ? (models ?? []).find((m) => m.value === effectiveModel)
    : undefined;

  // Both readings come from the runtime's own declaration: the server default
  // row carries it forward, and the capability map is the source it was derived
  // from — so an agent on a runtime the defaults have no row for still gets the
  // real answer.
  const declaredEffortSupport =
    serverForRuntime?.supportsEffort ?? settingsForRuntime(capabilityMap, runtime)?.supportsEffort;
  // Neither having answered while the capability query is still in flight is
  // "not asked yet", and the two halves treat that differently on purpose. The
  // report below stays permissive: a stored effort is never called broken on a
  // guess. The CONTROL cannot be. Offering an editable effort row for the
  // length of one round-trip and then swapping it for "Not supported by
  // OpenCode" is offering a setting that was never there, so while the answer
  // is unknown the row says only that. Once the query settles without an answer
  // — a runtime this cockpit has no declaration for at all — the permissive
  // reading stands, because that absence is not going to resolve.
  const effortSupportUnknown = declaredEffortSupport === undefined && capabilitiesPending;
  const runtimeHasEffort = declaredEffortSupport !== false;
  const modelTakesEffort = selectedModel ? (selectedModel.supportsEffort ?? false) : undefined;

  // Billing accounts belong to Claude Code alone, so everything below is read
  // from the server's account registry and only ever drawn for that runtime.
  //
  // The id filter is defensive rather than load-bearing: the server heals an id
  // onto every registered account before it reaches the wire, so this path has
  // none to drop. The wire type permits `null` for a row a caller synthesizes to
  // describe an unregistered root, and nothing may point at one (ADR
  // 260821-205324) — so the filter states that rule at the place it matters,
  // which is the list of things a person can choose.
  const accountRows = config?.claudeCode?.accounts;
  const knownAccounts: (KnownAccount & { path: string })[] | undefined = accountRows?.flatMap(
    (row) =>
      row.id === null
        ? []
        : [{ id: row.id, label: claudeAccountName(row.path, accountRows), path: row.path }]
  );
  // `?? null`, not `!= null` alone: an in-flight optimistic reset carries the
  // wire's `null`, and every provenance read below has to see that as "back to
  // inheriting" rather than as a value (same rule as model and effort above).
  const accountId = agent.account ?? null;
  const accountIsSetHere = accountId !== null;
  // The account a new session would bill to with nothing set here — already
  // resolved by the server, because the client cannot compute it.
  const serverDefaultAccount = config?.claudeCode
    ? claudeAccountName(config.claudeCode.resolvedAccount, accountRows ?? [])
    : null;

  // **The Account row writes through the OPERATOR's route, never the agent
  // self-edit route** (DOR-1736) — the same split the Tools page's toggles took
  // in DOR-1506, and for the same reason.
  //
  // `agent-write-policy.ts` classifies `account` as `operator-only`: whose
  // subscription an agent's work bills to is a person's decision, so
  // `PATCH /api/agents/current` refuses ANY body naming it — 403, whole patch,
  // whatever the value. This row sent exactly that body, so on the only machines
  // that draw it (more than one registered account) every pick failed. Model and
  // effort beside it stay on `onUpdate`, because that route still accepts them.
  //
  // No optimistic write, and `onSettled` rather than `onSuccess`: the row is
  // drawn entirely from the stored manifest, so a re-read is the only thing that
  // ever moves it — and after a REFUSED write it is the only thing that proves
  // it did not. The refusal itself is reported by the app-wide mutation handler
  // (`shared/lib/query-client`), which runs even if this popover has closed.
  //
  // The invalidation is the one `ToolsTab` explains: `useUpdateAgent` clears
  // `['mesh','agents']` and stops, while this row renders whatever manifest its
  // caller holds — `agentKeys.byPath` in the profile popover, `agentKeys.resolved`
  // behind the Settings exceptions strip. The `agentKeys.all` prefix covers both.
  // The team roster is deliberately NOT swept: `TeamAgentFacts` carries `runtime`
  // and `model` and no account, so there is nothing there this write changes.
  const updateAgent = useUpdateMeshAgent();
  const queryClient = useQueryClient();
  const writeAccount = useCallback(
    (account: string | null) => {
      updateAgent.mutate(
        { id: agent.id, updates: { account } },
        {
          onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentKeys.all });
          },
        }
      );
    },
    [agent.id, queryClient, updateAgent]
  );

  // One report, the same rules the exceptions strip and the sidebar read, so a
  // row that wears a warning chip here is a row that is named there.
  const report = describeAgentExecution({
    agent: {
      runtime: agent.runtime,
      model: agent.model,
      effort: agent.effort,
      account: agent.account,
    },
    defaultRuntime,
    serverDefaultModel,
    knownModels: knownModelsFrom(models),
    knownAccounts,
    accountsUnavailable: config?.claudeCode?.accountsUnavailable,
    modelSupportsEffort: modelTakesEffort,
    runtimeSupportsEffort: declaredEffortSupport,
    runtimeLabel: (type) => getRuntimeDescriptor(type).label,
  });
  const breakageFor = (kinds: string[]) =>
    report.breakages.find((b) => kinds.includes(b.kind))?.message ?? null;

  // Whether the effort row below is a CHOICE or a sentence. The header above it
  // has to know, because a sentence carries no chip of its own — and a row
  // waiting on the declaration is one of the sentences.
  const effortIsChoosable = !effortSupportUnknown && runtimeHasEffort && modelTakesEffort !== false;
  const effectiveEffort = agent.effort ?? serverForRuntime?.effort ?? null;
  const runtimeLabel = getRuntimeDescriptor(runtime).label;

  // The Account row is the one row that is sometimes not a row at all.
  //
  // On any runtime but Claude Code there is no such thing as a billing account,
  // and on a machine that knows of only one there is nothing to choose — a
  // control whose every use is a no-op is worse than no control, because it
  // implies a decision a person does not have. It comes back for an agent that
  // HAS an account set, whatever the registry now holds, because that is
  // precisely the agent whose setting has to be visible to be cleared.
  //
  // Nothing is drawn until the config answers: a row that offered no accounts
  // for one round-trip and then offered three would have told a person the
  // wrong thing first.
  //
  // The threshold counts REGISTERED accounts — the ones the picker can actually
  // offer — rather than wire rows, so an id-less row cannot make a machine look
  // like it has a choice to make. It deliberately matches what the status bar
  // means by a multi-account machine (`isMultiAccount`): one surface offering a
  // per-agent account while the other hides its own account control would be
  // two answers to one question.
  const showAccountRow =
    runtime === 'claude-code' &&
    knownAccounts !== undefined &&
    (knownAccounts.length > 1 || accountIsSetHere);
  const accountWarning = breakageFor(['account-unregistered']);

  // With no provider connected the catalog arrives capped and every row marked
  // unverified, and the notice under the row says so. The trigger points at it
  // with `aria-describedby` — the same wiring the settings Model row uses — so
  // a person navigating by control HEARS that the list is a bounded guess
  // rather than only seeing the paragraph underneath (DOR-1674).
  const catalogIsUnverified = (models ?? []).some((m) => m.unverified);
  const unverifiedNoticeId = useId();

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)}>
      {/* The wrapper is this cell of the grid; the notice rides under the row
          when the catalog is the capped, unconfirmed slice (DOR-1674) — the
          same admission the composer picker and the settings Model row make. */}
      <div className="space-y-1.5">
        <ExecutionRow
          label="Model"
          valueLabel={selectedModel?.displayName ?? effectiveModel ?? 'Automatic'}
          options={[
            ...(models ?? []).map((m) => ({
              value: m.value,
              label: m.displayName,
              hint: m.description,
            })),
          ]}
          selected={effectiveModel}
          isSetHere={modelIsSetHere}
          serverDefault={serverForRuntime?.model ?? null}
          warning={breakageFor(['model-unavailable'])}
          onSelect={(value) => onUpdate({ model: value })}
          onInherit={() => onUpdate({ model: null })}
          testId="agent-model-row"
          describedBy={catalogIsUnverified ? unverifiedNoticeId : undefined}
        />
        {catalogIsUnverified && <UnverifiedCatalogNotice id={unverifiedNoticeId} />}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span className={LABEL_CLASS}>Effort</span>
          {/* The effort header is drawn HERE, not by the row below, because the
              row is only one of the things that can follow it — the rest are
              sentences. So the chip lives with the label, and stays even
              where there is no control at all, which is exactly the case where
              it is the only way left to clear a value that does nothing. */}
          {(!isMobile || !effortIsChoosable) && (effortIsSetHere || effortIsChoosable) && (
            <ProvenanceChip
              isSetHere={effortIsSetHere}
              serverDefault={serverForRuntime?.effort ? effortLabel(serverForRuntime.effort) : null}
              warning={breakageFor(['effort-unsupported-runtime', 'effort-unsupported-model'])}
              onUseServerDefault={() => onUpdate({ effort: null })}
              data-testid="agent-effort-row-chip"
            />
          )}
        </div>

        {effortSupportUnknown ? (
          <EffortNote
            testId="agent-effort-pending"
            text={`Checking what ${runtimeLabel} supports`}
            warning={null}
          />
        ) : !runtimeHasEffort ? (
          <EffortNote
            testId="agent-effort-unsupported-runtime"
            text={`Not supported by ${runtimeLabel}`}
            warning={breakageFor(['effort-unsupported-runtime'])}
          />
        ) : !effortIsChoosable ? (
          <EffortNote
            testId="agent-effort-unsupported-model"
            text="This model doesn't take an effort setting"
            warning={breakageFor(['effort-unsupported-model'])}
          />
        ) : (
          <ExecutionRow
            label="Effort"
            valueLabel={effortLabel(effectiveEffort)}
            options={EFFORT_LEVELS.filter(
              (level) =>
                !selectedModel?.supportedEffortLevels ||
                selectedModel.supportedEffortLevels.includes(level)
            ).map((level) => ({ value: level, label: effortLabel(level) }))}
            selected={effectiveEffort}
            isSetHere={effortIsSetHere}
            serverDefault={serverForRuntime?.effort ? effortLabel(serverForRuntime.effort) : null}
            warning={null}
            showHeader={false}
            onSelect={(value) => onUpdate({ effort: value as EffortLevel })}
            onInherit={() => onUpdate({ effort: null })}
            testId="agent-effort-row"
          />
        )}
      </div>

      {showAccountRow && (
        <ExecutionRow
          label="Account"
          valueLabel={
            accountId !== null
              ? // The registry's name where the id still resolves, the raw id
                // where it does not — a row about a broken reference that hid
                // the reference would be unfixable.
                (knownAccounts?.find((a) => a.id === accountId)?.label ?? accountId)
              : (serverDefaultAccount ?? 'Default account')
          }
          options={(knownAccounts ?? []).map((account) => ({
            value: account.id,
            label: account.label,
            // The folder under the name: two accounts an operator labelled
            // similarly are told apart by where they live, and nowhere else.
            hint: shortenHomePath(account.path),
          }))}
          selected={accountId}
          isSetHere={accountIsSetHere}
          serverDefault={serverDefaultAccount}
          warning={accountWarning}
          onSelect={(value) => writeAccount(value)}
          onInherit={() => writeAccount(null)}
          testId="agent-account-row"
          className="col-span-full"
        />
      )}
    </div>
  );
}

/**
 * Effort where it cannot be chosen — because the runtime or the model takes
 * none, or because the runtime has not said yet: the truth, in muted text, with
 * the row still there.
 *
 * Kept as a row rather than removed because an absent row answers nothing — a
 * person looking for the effort setting would go on looking. When an effort IS
 * stored despite this, the soft warning shows beneath it, because a stored value
 * that does nothing is worth saying out loud (§3.4).
 */
function EffortNote({
  text,
  warning,
  testId,
}: {
  text: string;
  warning: string | null;
  testId: string;
}) {
  return (
    <div className="flex h-8 flex-col justify-center" data-testid={testId}>
      <p className="text-muted-foreground text-xs">{text}</p>
      {warning && <p className="text-xs text-amber-700 dark:text-amber-400">{warning}</p>}
    </div>
  );
}
