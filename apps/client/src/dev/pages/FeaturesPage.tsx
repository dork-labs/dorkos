import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { FEATURES_SECTIONS } from '../playground-registry';
import { AgentIdentityShowcases } from '../showcases/AgentIdentityShowcases';
import { AgentSidebarShowcases } from '../showcases/AgentSidebarShowcases';
import { RelayShowcases } from '../showcases/RelayShowcases';
import { AdapterWizardShowcases } from '../showcases/AdapterWizardShowcases';
import { MeshShowcases } from '../showcases/MeshShowcases';
import { TasksShowcases } from '../showcases/TasksShowcases';
import { PersonalityPickerShowcases } from '../showcases/PersonalityPickerShowcases';

/** Feature component showcase page for the dev playground. */
export function FeaturesPage() {
  return (
    <PlaygroundPageLayout
      title="Feature Components"
      description="Domain-specific components from Relay, Mesh, and Tasks features."
      sections={FEATURES_SECTIONS}
    >
      <PersonalityPickerShowcases />
      <AgentIdentityShowcases />
      <AgentSidebarShowcases />
      <RelayShowcases />
      <AdapterWizardShowcases />
      <MeshShowcases />
      <TasksShowcases />
    </PlaygroundPageLayout>
  );
}
