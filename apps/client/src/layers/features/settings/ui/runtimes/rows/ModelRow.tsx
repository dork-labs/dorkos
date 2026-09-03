/**
 * The Model row of a runtime card — which model a new conversation starts on.
 *
 * Presentational on purpose (design decision 7): a catalog and a value in, a
 * change out. No query, no config write, no hook of any kind, which is what lets
 * the dev playground render the real row and lets three cards render three of
 * them at once without any of them fetching anything.
 *
 * @module features/settings/ui/runtimes/rows/ModelRow
 */
import { useId } from 'react';
import type { ModelOption } from '@dorkos/shared/types';
import { knownModelsFrom } from '@/layers/shared/lib';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
  UnverifiedCatalogNotice,
} from '@/layers/shared/ui';

/**
 * Stands in for "no default", which reports `null`. Radix refuses an
 * empty-string item value, so the absence needs a spelling.
 */
const INHERIT = '__inherit__';

/** What the Model row needs to be told, and the one thing it says back. */
export interface ModelRowProps {
  /**
   * Runtime type id, e.g. `'claude-code'`. Scopes the row's test id: three cards
   * render this row at once now, so a page-global id could not name one of them.
   */
  runtimeType: string;
  /** What a person calls the runtime, for the row's own sentence. */
  runtimeLabel: string;
  /** The runtime's live catalog, or `undefined` while nobody has fetched it. */
  models: ModelOption[] | undefined;
  /** The configured model id, or `null` for "let the runtime choose". */
  value: string | null;
  /** Report a pick. `null` means back to the runtime's choice. */
  onChange: (value: string | null) => void;
  /**
   * Freeze the control. Two callers, one meaning — there is nothing a pick could
   * do: a runtime that is not connected has no catalog to offer, and one that has
   * not said where its settings live has nowhere to keep the answer.
   */
  disabled?: boolean;
}

/**
 * Which model a new conversation on this runtime starts on.
 *
 * Two things about it are load-bearing, and both are honesty rules the card
 * carried over from the settings card it replaces (design §5):
 *
 * - **A model that is set but no longer offered stays selectable**, labelled
 *   `(no longer offered)`. Never silently swapped for a neighbour: the field
 *   would then show something the person did not choose.
 * - **A catalog nobody has fetched accuses nothing.** `knownModelsFrom` is the
 *   repo's one rule for that — an absent OR empty catalog is a catalog that has
 *   not answered — so a card opened before its models arrive names the pinned
 *   model rather than calling it retired for the length of one round-trip.
 *
 * @param props - The catalog, the configured model, and the change handler.
 */
export function ModelRow({
  runtimeType,
  runtimeLabel,
  models,
  value,
  onChange,
  disabled,
}: ModelRowProps) {
  const known = knownModelsFrom(models);
  const gone = value !== null && known !== undefined && !known.includes(value);
  // With no provider connected the catalog arrives capped and every row marked
  // unverified. The composer picker admits that (DOR-1660); this row renders the
  // same catalog and owes the same admission (DOR-1674). An absent or empty
  // catalog is a warming one, not an unconfirmed one — no rows, no notice.
  const unverifiedCatalog = (models ?? []).some((m) => m.unverified);
  // The admission must reach a screen reader too: the trigger describes itself
  // by the notice, so a person navigating by control hears that the list is a
  // bounded guess instead of only seeing it.
  const noticeId = useId();

  return (
    <SettingRow
      label="Model"
      description={`Which ${runtimeLabel} model a new conversation starts on. Leave it on Automatic to let ${runtimeLabel} pick.`}
    >
      <div className="w-52 space-y-1.5">
        <Select
          value={value ?? INHERIT}
          disabled={disabled}
          onValueChange={(next) => onChange(next === INHERIT ? null : next)}
        >
          <SelectTrigger
            className="w-full"
            aria-label={`Default ${runtimeLabel} model`}
            {...(unverifiedCatalog ? { 'aria-describedby': noticeId } : {})}
            data-testid={`runtime-model-select-${runtimeType}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Automatic</SelectItem>
            {(models ?? []).map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.displayName}
              </SelectItem>
            ))}
            {/* Set but absent from the catalog: still an item, or the field would
              show a value the list cannot express. A catalog that has not
              answered yet gets the same item without the accusation. */}
            {value !== null && !(models ?? []).some((m) => m.value === value) && (
              <SelectItem value={value}>{gone ? `${value} (no longer offered)` : value}</SelectItem>
            )}
          </SelectContent>
        </Select>
        {unverifiedCatalog && <UnverifiedCatalogNotice id={noticeId} />}
      </div>
    </SettingRow>
  );
}
