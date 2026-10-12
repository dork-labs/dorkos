/**
 * What the DorkOS runtime card's Model row offers (DOR-2784, spec
 * `one-minute-onboarding` §6.5).
 *
 * - `credits`: nothing is configured and credits are in use, so DorkOS picks.
 *   The row offers the credits catalog; a pick is a model PREFERENCE
 *   (`runtimes.doe.defaultModel`, written like any runtime's default model),
 *   never a payer, and "Chosen by DorkOS" clears it.
 * - `own`: an explicit setup (own key, local model) names its model; the setup
 *   form changes it, so the row only shows it.
 * - `none`: nothing configured and no credits in use: nothing to choose yet.
 *
 * @module features/settings/model/use-doe-model-row
 */
import { useQuery } from '@tanstack/react-query';
import type { ModelOption } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { CHOSEN_BY_DORKOS } from '@dorkos/shared/runtime-connect';

/** Which of the three states the row is in; `null` while loading or not DorkOS. */
export type DoeModelRowState = 'credits' | 'own' | 'none';

/** What the Doe card's Model row is told. */
export interface DoeModelRow {
  /** The row's state, or `null` when this is not the DorkOS card or it is loading. */
  state: DoeModelRowState | null;
  /** The credits catalog in the format DorkOS picks in, or `undefined` while it loads. */
  models: ModelOption[] | undefined;
}

/**
 * Read what the Doe card's Model row offers.
 *
 * @param enabled - Whether this card is the DorkOS runtime's, on this computer.
 */
export function useDoeModelRow(enabled: boolean): DoeModelRow {
  const transport = useTransport();
  const { data: saved } = useQuery({
    queryKey: ['doe-inference'],
    queryFn: () => transport.getDoeInference(),
    enabled,
  });
  const protocol = saved?.autoProtocol ?? null;
  const state: DoeModelRowState | null =
    !enabled || saved === undefined
      ? null
      : saved.inference !== null
        ? 'own'
        : protocol !== null
          ? 'credits'
          : 'none';
  const { data: catalog } = useQuery({
    queryKey: ['doe-credits-models', protocol],
    // `enabled` holds this back until there is a format to ask about.
    queryFn: () => transport.getDoeCreditsModels(protocol ?? 'anthropic-messages'),
    enabled: state === 'credits',
  });
  return {
    state,
    models: catalog?.models.map((model) => ({
      value: model.id,
      displayName: model.displayName,
      description: '',
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      paidFromCredits: true,
    })),
  };
}

/** How the card's summary names a model DorkOS picks: "Starts with a model chosen by DorkOS". */
export const DOE_PICKS_SUMMARY = 'a model chosen by DorkOS';

/**
 * The Model row's own words for each state, beside `ModelRow`'s props.
 *
 * @param state - The row's state; `null` changes nothing.
 */
export function doeModelRowCopy(state: DoeModelRowState | null): {
  inheritLabel?: string;
  description?: string;
} {
  switch (state) {
    case 'credits':
      return { inheritLabel: CHOSEN_BY_DORKOS, description: 'Which model new chats start on.' };
    case 'own':
      return { description: 'Change it in the DorkOS setup.' };
    case 'none':
      return { inheritLabel: 'None yet', description: 'Connect AI to choose a model.' };
    case null:
      return {};
  }
}
