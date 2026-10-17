import type { EmbedRegistry } from 'blintz';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { DOCS_EXPERIMENT } from '@/layers/shared/model';
import { DOC_EMBEDS } from '../ui/doc-embed-registry';

/**
 * The embed registry to hand a markdown editor: the Docs embeds while the Docs
 * experiment is on, `undefined` while it is off, so the editor gets no Docs prop
 * at all and every directive keeps Blintz's own placeholder.
 */
export function useDocEmbeds(): EmbedRegistry | undefined {
  return useExperimentEnabledState(DOCS_EXPERIMENT).enabled ? DOC_EMBEDS : undefined;
}
