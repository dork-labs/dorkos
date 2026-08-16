import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentManifest, AgentManifestUpdate } from '@dorkos/shared/mesh-schemas';
import type { EffortLevel } from '@dorkos/shared/types';
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import { cn, describeAgentExecution, effortLabel, knownModelsFrom } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import {
  ProvenanceChip,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { useConfig } from '@/layers/entities/config';
import {
  getRuntimeDescriptor,
  settingsForRuntime,
  useRuntimeCapabilities,
} from '@/layers/entities/runtime';
import { useModels } from '@/layers/entities/session';

/** The field-label style every cell in the Config tab's metadata grid uses. */
const LABEL_CLASS = 'text-muted-foreground text-[10px] font-medium tracking-wider uppercase';

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
    <div className="space-y-1">
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
   * Persist a manifest change. `null` on either key means "go back to
   * inheriting", which is exactly what the wire's `null` means.
   */
  onUpdate: (updates: AgentManifestUpdate) => void;
}

/**
 * An agent's Model and Effort rows — the two settings that join the Runtime
 * choice beside them (spec `execution-defaults` §2).
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
 * @param props - See {@link AgentExecutionRowsProps}.
 */
export function AgentExecutionRows({ agent, onUpdate }: AgentExecutionRowsProps) {
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

  // One report, the same rules the exceptions strip and the sidebar read, so a
  // row that wears a warning chip here is a row that is named there.
  const report = describeAgentExecution({
    agent: { runtime: agent.runtime, model: agent.model, effort: agent.effort },
    defaultRuntime,
    serverDefaultModel,
    knownModels: knownModelsFrom(models),
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

  return (
    <div className="grid grid-cols-2 gap-3">
      <ExecutionRow
        label="Model"
        valueLabel={selectedModel?.displayName ?? effectiveModel ?? "Runtime's choice"}
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
      />

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
