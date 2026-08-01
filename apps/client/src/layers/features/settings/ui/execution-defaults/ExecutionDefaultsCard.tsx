import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import type { EffortLevel } from '@dorkos/shared/types';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import { effortLabel, resolveTrustStops } from '@/layers/shared/lib';
import {
  FieldCard,
  FieldCardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  SettingRow,
} from '@/layers/shared/ui';
import { useAutonomyAcknowledgement, useConfig, useUpdateConfig } from '@/layers/entities/config';
import { getRuntimeDescriptor, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useModels } from '@/layers/entities/session';
// UI composition across features, which the layer rule allows: the door into
// Full autonomy is one dialog and one contract, and Settings asks the same
// question the session dial asks rather than a second version of it.
import { AutonomyConfirmDialog } from '@/layers/features/status';
import { DefaultTrustStopSection, type DefaultTrustStopRuntime } from './DefaultTrustStopSection';

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
  const autonomyAck = useAutonomyAcknowledgement();
  const [writeError, setWriteError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  /**
   * The Full-autonomy default waiting on the dialog — which runtime it is for
   * (`null` = the global setting), and the mode whose promise the dialog reads
   * out. Held here rather than inside the section because consent is a
   * conversation with the SERVER: the config route refuses this write without an
   * acknowledgement, and this is the component that makes the write.
   */
  const [pendingAutonomy, setPendingAutonomy] = useState<{
    runtime: string | null;
    descriptor: PermissionModeDescriptor;
  } | null>(null);

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
    writeConfig({ runtimes: patch });
  }

  /**
   * Persist one whole-config patch.
   *
   * Separate from {@link write} for exactly one caller: the Full-autonomy
   * default has to carry `ui.autonomyAcknowledgedAt` in the SAME request as the
   * new stop. The server refuses the stop without an acknowledgement, so two
   * requests would race — the stop could land first and bounce — and one patch
   * has no such window.
   */
  function writeConfig(patch: Record<string, unknown>) {
    setWriteError(null);
    updateConfig.mutate(patch, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['config'] });
        setChanged(true);
      },
      onError: (err) => setWriteError(describeWriteFailure(err)),
    });
  }

  function writeForRuntime(patch: Record<string, unknown>) {
    const section = CONFIG_SECTION[runtime];
    if (!section) return;
    write({ [section]: patch });
  }

  /** The `runtimes` patch that sets one trust stop — global when `forRuntime` is null. */
  function trustStopPatch(
    forRuntime: string | null,
    stop: PermissionStop | null
  ): Record<string, unknown> | null {
    if (forRuntime === null) return { defaultTrustStop: stop };
    const section = CONFIG_SECTION[forRuntime];
    return section ? { [section]: { defaultTrustStop: stop } } : null;
  }

  /**
   * Change where new sessions start, asking first when that is Full autonomy and
   * this person has no standing acknowledgement.
   *
   * Set-time is consent-time (spec `trust-dial`, decision 6): the acknowledgement
   * given here is what lets every session this default births start bypassed
   * without meeting the dialog again.
   *
   * @param forRuntime - Which runtime's setting, or `null` for the global one.
   * @param stop - The stop to store, or `null` to return a runtime to the global
   *   setting. A `null` is never Full autonomy, so it never asks.
   */
  function changeTrustStop(forRuntime: string | null, stop: PermissionStop | null) {
    const patch = trustStopPatch(forRuntime, stop);
    if (!patch) return;
    if (stop === 'autonomy' && autonomyAck.acknowledgedAt === null) {
      // The runtime whose promise the dialog reads out: the one being changed,
      // or the runtime a new session would land on when the choice is global.
      // Its own sentence, never copy written here — what Full autonomy means
      // differs by agent, and a stand-in would be wrong for somebody.
      const descriptor = autonomyDescriptorFor(forRuntime ?? runtime);
      if (descriptor) {
        setPendingAutonomy({ runtime: forRuntime, descriptor });
        return;
      }
    }
    write(patch);
  }

  /** The mode a runtime declares at its autonomy stop, if it declares one. */
  function autonomyDescriptorFor(runtimeType: string): PermissionModeDescriptor | undefined {
    const declared = capabilityMap?.capabilities[runtimeType]?.permissionModes?.values ?? [];
    return resolveTrustStops(declared).find((s) => s.stop === 'autonomy')?.mode;
  }

  /**
   * The person read what Full autonomy means and said yes. Record the
   * acknowledgement and the new default together — see {@link writeConfig}.
   */
  function confirmAutonomyDefault() {
    if (!pendingAutonomy) return;
    const patch = trustStopPatch(pendingAutonomy.runtime, 'autonomy');
    setPendingAutonomy(null);
    if (!patch) return;
    writeConfig({
      ui: { autonomyAcknowledgedAt: new Date().toISOString() },
      runtimes: patch,
    });
  }

  /** Every runtime with a settings section, as the trust section needs it. */
  const trustRuntimes: DefaultTrustStopRuntime[] = (defaults?.perRuntime ?? []).map((entry) => ({
    runtime: entry.runtime,
    label: getRuntimeDescriptor(entry.runtime).label,
    stop: entry.trustStop,
    // Optional all the way down: a runtime the capability map has not answered
    // for yet contributes no descriptors, and no descriptors means the section
    // says "no such setting here" rather than throwing on a half-loaded map.
    descriptors: capabilityMap?.capabilities[entry.runtime]?.permissionModes?.values ?? [],
  }));

  // What `null` actually means today: the default runtime's own starting mode,
  // read from its profile. Shown as the dial's selection so the control says
  // what will happen rather than leaving a person to guess at an empty setting.
  const defaultRuntimeModes = capabilityMap?.capabilities[runtime]?.permissionModes;
  const runtimeDefaultStop =
    defaultRuntimeModes?.values?.find((d) => d.id === defaultRuntimeModes.default)?.stop ?? 'ask';

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

        <Separator />

        {/* The one setting in this card that is not per runtime: a trust stop
            means the same thing everywhere, so it is answered once and resolved
            through each runtime's own profile (spec `trust-dial`, decision 6). */}
        <DefaultTrustStopSection
          stop={defaults?.trustStop ?? null}
          effectiveStop={runtimeDefaultStop}
          runtimes={trustRuntimes}
          onChangeGlobal={(stop) => changeTrustStop(null, stop)}
          onChangeRuntime={(target, stop) => changeTrustStop(target, stop)}
        />

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

        {/* The door, at set-time. No "don't show this again" checkbox: agreeing
            HERE is itself the standing record — the server requires one for this
            write, and offering the choice would make it look optional when the
            setting cannot exist without it. */}
        <AutonomyConfirmDialog
          descriptor={pendingAutonomy?.descriptor ?? null}
          canRemember={false}
          consentNote="Every new session will start here, and DorkOS will remember that you have read this."
          onCancel={() => setPendingAutonomy(null)}
          onConfirm={confirmAutonomyDefault}
        />
      </FieldCardContent>
    </FieldCard>
  );
}
