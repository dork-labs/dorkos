import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { GEN_UI_SECTIONS } from '../playground-registry';
import { GenUiShowcases } from '../showcases/GenUiShowcases';

/** Generative UI widget gallery page for the dev playground. */
export function GenUiPage() {
  return (
    <PlaygroundPageLayout
      title="Generative UI"
      description="Agent-authored widgets rendered from dorkos-ui fences — every catalog node, the streaming loading state, and the error fallback."
      sections={GEN_UI_SECTIONS}
    >
      <GenUiShowcases />
    </PlaygroundPageLayout>
  );
}
