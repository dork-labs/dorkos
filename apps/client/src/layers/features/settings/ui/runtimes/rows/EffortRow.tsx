/**
 * The Effort row of a runtime card — how hard a new conversation thinks, and the
 * two ways that question can honestly have no answer.
 *
 * Presentational on purpose (design decision 7): values in, one change out.
 *
 * @module features/settings/ui/runtimes/rows/EffortRow
 */
import type { EffortLevel, ModelOption } from '@dorkos/shared/types';
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import { effortLabel } from '@/layers/shared/lib';
import { SegmentedControl, SegmentedControlItem, SettingRow } from '@/layers/shared/ui';

/**
 * Stands in for "no preference", which reports `null` — the ladder's way back to
 * the runtime's own choice, spelled the same way the Model row spells it.
 */
const INHERIT = '__inherit__';

/** What the Effort row needs to be told, and the one thing it says back. */
export interface EffortRowProps {
  /** Runtime type id, e.g. `'claude-code'`. Scopes the row's test ids per card. */
  runtimeType: string;
  /** What a person calls the runtime, for the row's own sentences. */
  runtimeLabel: string;
  /** Whether the runtime's API has an effort setting at all. */
  supportsEffort: boolean;
  /**
   * The configured model's catalog entry, or `undefined` when the catalog has
   * not answered. Effort is a per-MODEL capability as well as a per-runtime one,
   * so the model chosen a row up decides what this row may offer.
   */
  selectedModel: ModelOption | undefined;
  /** The configured model id, for naming a model the catalog cannot name. */
  configuredModelId: string | null;
  /** The configured rung, or `null` for "let the runtime choose". */
  value: EffortLevel | null;
  /** Report a pick. `null` means back to the runtime's choice. */
  onChange: (value: EffortLevel | null) => void;
}

/**
 * How hard a new conversation on this runtime thinks before it answers.
 *
 * The row that has to tell the truth three different ways, and none of the three
 * is a hidden row (design §5 — said, not hidden):
 *
 * - **The runtime has no such setting.** One muted sentence naming it. The row
 *   stays, because the absence is the answer.
 * - **The runtime has one and the model does not take it.** The same rule a
 *   level down, named after the MODEL — that is the row a person would change to
 *   get the setting back. An effort already saved against such a model keeps a
 *   one-tap way out, or clearing a setting that does nothing would mean
 *   switching the model back first.
 * - **Both take it.** The ladder, filtered to the rungs this model accepts.
 *
 * A model whose catalog entry has not arrived leaves the whole ladder up:
 * evidence nobody has is never evidence against, and narrowing on a guess would
 * quietly drop the rung somebody already chose.
 *
 * @param props - The two capability answers, the configured rung, and the
 *   change handler.
 */
export function EffortRow({
  runtimeType,
  runtimeLabel,
  supportsEffort,
  selectedModel,
  configuredModelId,
  value,
  onChange,
}: EffortRowProps) {
  const modelTakesEffort = selectedModel ? (selectedModel.supportsEffort ?? false) : true;
  const rungs = EFFORT_LEVELS.filter(
    (level) =>
      !selectedModel?.supportedEffortLevels || selectedModel.supportedEffortLevels.includes(level)
  );

  return (
    <SettingRow
      label="Effort"
      description="How hard a new conversation thinks before it answers."
      orientation="vertical"
    >
      {!supportsEffort ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid={`runtime-effort-unsupported-${runtimeType}`}
        >
          Not supported by {runtimeLabel}
        </p>
      ) : !modelTakesEffort ? (
        <div
          className="flex flex-col gap-1"
          data-testid={`runtime-effort-model-unsupported-${runtimeType}`}
        >
          <p className="text-muted-foreground text-xs">
            {selectedModel?.displayName ?? configuredModelId} doesn&apos;t take an effort setting
          </p>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="focus-ring self-start rounded-sm text-xs text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
              data-testid={`runtime-effort-clear-${runtimeType}`}
            >
              {effortLabel(value)} is saved here and does nothing — clear it
            </button>
          )}
        </div>
      ) : (
        <SegmentedControl
          aria-label={`Default ${runtimeLabel} effort`}
          data-testid={`runtime-effort-${runtimeType}`}
          value={value ?? INHERIT}
          onValueChange={(next) => onChange(next === INHERIT ? null : (next as EffortLevel))}
        >
          <SegmentedControlItem value={INHERIT}>
            <span className="truncate">Runtime&apos;s choice</span>
          </SegmentedControlItem>
          {rungs.map((level) => (
            <SegmentedControlItem key={level} value={level}>
              <span className="truncate">{effortLabel(level)}</span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      )}
    </SettingRow>
  );
}
