import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import type { EffortLevel } from '@dorkos/shared/types';
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import { effortLabel } from '@/layers/shared/lib';
import {
  FieldCard,
  FieldCardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
} from '@/layers/shared/ui';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { getRuntimeDescriptor, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useModels } from '@/layers/entities/session';

/**
 * Stands in for "no default", which writes `null`. Radix refuses an empty-string
 * item value, so the absence needs a spelling — same trick as the accounts card.
 */
const INHERIT = '__inherit__';

/** Which config section holds a runtime's defaults. Mirrors the server's own map. */
const CONFIG_SECTION: Readonly<Record<string, 'claudeCode' | 'codex' | 'opencode'>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
};

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Could not save that. Try again.';
}

/**
 * What a new conversation starts with: the runtime, the model, and how hard it
 * thinks (spec `execution-defaults` §1).
 *
 * The first UI `runtimes.default` has ever had — it was a config file field that
 * the cockpit applied at boot and never showed. Model and effort join it here
 * because they answer the same question and a person changing one usually means
 * to look at the others.
 *
 * **Model and effort are per runtime, and the card says so** by scoping them to
 * the runtime chosen above: a model id only means something inside the runtime
 * that offers it, so one shared field would be wrong for two runtimes the moment
 * anybody set it. Switching the runtime row re-points the two below it.
 *
 * The timing line appears only after a change (§3.2, progressive disclosure) —
 * before then there is nothing to reassure anybody about.
 */
export function ExecutionDefaultsCard() {
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const [writeError, setWriteError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const defaults = config?.executionDefaults;
  const runtime = defaults?.runtime ?? 'claude-code';
  const forRuntime = defaults?.perRuntime.find((entry) => entry.runtime === runtime);
  const registered = capabilityMap ? Object.keys(capabilityMap.capabilities) : [];
  // The chosen runtime always appears, registered or not: a default pointing at a
  // runtime this machine has not connected is exactly the state a person came
  // here to see and change, and dropping it from its own list would hide it.
  const runtimeOptions = registered.includes(runtime) ? registered : [runtime, ...registered];

  const { data: models } = useModels({ runtime });

  /**
   * Persist one change under `runtimes`.
   *
   * Invalidates the `['config']` PREFIX, not just this card's key: the status
   * bar, the sidebar badges and `useFeatureEnabled` read config off a broader
   * key set, and the default runtime is applied live by the server, so every
   * reader has to move with the write.
   */
  function write(patch: Record<string, unknown>) {
    setWriteError(null);
    updateConfig.mutate(
      { runtimes: patch },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['config'] });
          setChanged(true);
        },
        onError: (err) => setWriteError(describeWriteFailure(err)),
      }
    );
  }

  function writeForRuntime(patch: Record<string, unknown>) {
    const section = CONFIG_SECTION[runtime];
    if (!section) return;
    write({ [section]: patch });
  }

  const runtimeLabel = getRuntimeDescriptor(runtime).label;

  // Effort is a per-MODEL capability, not only a per-runtime one, and this card
  // sets both — so the model chosen two rows up decides what the effort row may
  // offer, exactly as it does in an agent's Config tab. Without this, Claude
  // Code's blanket "supports effort" let Haiku be paired with High here and
  // nowhere else, and the fleet's own strip would then call the result broken.
  const defaultModel = forRuntime?.model
    ? (models ?? []).find((m) => m.value === forRuntime.model)
    : undefined;
  // A default model whose catalog entry has not arrived leaves the full list:
  // evidence nobody has is never evidence against, and narrowing a list on a
  // guess would quietly drop the rung somebody already chose.
  const modelTakesEffort = defaultModel ? (defaultModel.supportsEffort ?? false) : true;
  const effortOptions = EFFORT_LEVELS.filter(
    (level) =>
      !defaultModel?.supportedEffortLevels || defaultModel.supportedEffortLevels.includes(level)
  );

  return (
    <FieldCard data-section="execution-defaults">
      <FieldCardContent>
        <SettingRow
          label="Runtime"
          description="New conversations start here unless you pick another one when you start them."
        >
          <Select value={runtime} onValueChange={(value) => write({ default: value })}>
            <SelectTrigger
              className="w-52"
              aria-label="Default runtime"
              data-testid="default-runtime-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {runtimeOptions.map((type) => (
                <SelectItem key={type} value={type}>
                  {getRuntimeDescriptor(type).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="Model"
          description={`Which ${runtimeLabel} model a new conversation starts on. Leave it on Runtime's choice to let ${runtimeLabel} decide.`}
        >
          <Select
            value={forRuntime?.model ?? INHERIT}
            onValueChange={(value) =>
              writeForRuntime({ defaultModel: value === INHERIT ? null : value })
            }
          >
            <SelectTrigger
              className="w-52"
              aria-label="Default model"
              data-testid="default-model-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Runtime&apos;s choice</SelectItem>
              {(models ?? []).map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.displayName}
                </SelectItem>
              ))}
              {/* A model that is set but no longer offered still has to be
                  selectable, or the field would silently show something the list
                  cannot express. */}
              {forRuntime?.model && !(models ?? []).some((m) => m.value === forRuntime.model) && (
                <SelectItem value={forRuntime.model}>
                  {forRuntime.model} (no longer offered)
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="Effort"
          description="How hard a new conversation thinks before it answers."
        >
          {forRuntime && !forRuntime.supportsEffort ? (
            // Said, not hidden (§3.4). The row stays so the absence is an answer.
            <p className="text-muted-foreground text-xs" data-testid="default-effort-unsupported">
              Not supported by {runtimeLabel}
            </p>
          ) : !modelTakesEffort ? (
            // Same rule, one level down: the runtime has an effort setting, the
            // model chosen above does not take one. Named after the model,
            // because that is the row a person would change to get it back. An
            // effort already saved here still has its way out, or the only way
            // to clear a setting that does nothing would be to switch the model
            // back first.
            <div className="text-right" data-testid="default-effort-model-unsupported">
              <p className="text-muted-foreground text-xs">
                {defaultModel?.displayName ?? forRuntime?.model} doesn&apos;t take an effort setting
              </p>
              {forRuntime?.effort && (
                <button
                  type="button"
                  onClick={() => writeForRuntime({ defaultEffort: null })}
                  className="text-xs text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
                  data-testid="default-effort-clear"
                >
                  {effortLabel(forRuntime.effort)} is saved here and does nothing — clear it
                </button>
              )}
            </div>
          ) : (
            <Select
              value={forRuntime?.effort ?? INHERIT}
              onValueChange={(value) =>
                writeForRuntime({
                  defaultEffort: value === INHERIT ? null : (value as EffortLevel),
                })
              }
            >
              <SelectTrigger
                className="w-52"
                aria-label="Default effort"
                data-testid="default-effort-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>Runtime&apos;s choice</SelectItem>
                {effortOptions.map((level) => (
                  <SelectItem key={level} value={level}>
                    {effortLabel(level)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingRow>

        {changed && (
          <p className="text-muted-foreground text-xs" data-testid="execution-defaults-timing">
            Applies to new conversations — running ones keep their settings.
          </p>
        )}

        {writeError && (
          <p
            className="text-destructive flex items-start gap-1.5 text-xs"
            data-testid="execution-defaults-error"
          >
            <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
            <span>{writeError}</span>
          </p>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}
