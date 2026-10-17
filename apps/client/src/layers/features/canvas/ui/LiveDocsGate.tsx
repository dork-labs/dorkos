import type { ReactNode } from 'react';
import { DOCS_EXPERIMENT } from '@/layers/shared/model';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { LiveDocsContext } from '../model/live-docs-context';

/**
 * Turn live doc editing on for every canvas below while the `docs.enabled`
 * experiment is on (DOR-2984). Mounted once, by the app shell.
 */
export function LiveDocsGate({ children }: { children: ReactNode }) {
  const docs = useExperimentEnabledState(DOCS_EXPERIMENT);
  return <LiveDocsContext.Provider value={docs.enabled}>{children}</LiveDocsContext.Provider>;
}
