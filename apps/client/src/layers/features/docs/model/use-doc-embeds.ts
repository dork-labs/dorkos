import type { EmbedRegistry } from 'blintz';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { DOCS_EXPERIMENT } from '@/layers/shared/model';
import { DOC_EMBEDS, DOC_EMBEDS_FOR_READERS } from '../ui/doc-embed-registry';

/**
 * The embed registry to hand a markdown editor, or `undefined` while the Docs
 * experiment is off, so the editor gets no Docs prop at all and every directive
 * keeps Blintz's own placeholder.
 *
 * @param canEdit - Whether this person can edit the doc, now or by switching to
 *   edit. Only they see why an embed did not draw; a reader sees a quiet line.
 */
export function useDocEmbeds(canEdit: boolean): EmbedRegistry | undefined {
  const { enabled } = useExperimentEnabledState(DOCS_EXPERIMENT);
  if (!enabled) return undefined;
  return canEdit ? DOC_EMBEDS : DOC_EMBEDS_FOR_READERS;
}
