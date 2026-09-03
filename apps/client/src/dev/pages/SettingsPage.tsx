import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { SETTINGS_SECTIONS } from '../playground-registry';
import { SettingsShowcases } from '../showcases/SettingsShowcases';
import { RemoteAccessShowcases } from '../showcases/RemoteAccessShowcases';
import { RuntimeCardShowcases } from '../showcases/RuntimeCardShowcases';

/** Settings dialog showcase page for the dev playground. */
export function SettingsPage() {
  return (
    <PlaygroundPageLayout
      title="Settings"
      description="Settings dialogs, individual tabs, the Runtimes tab's cards in every state they can reach, mobile drill-in, loading and empty states, and the underlying primitives."
      sections={SETTINGS_SECTIONS}
    >
      <RuntimeCardShowcases />
      <SettingsShowcases />
      <RemoteAccessShowcases />
    </PlaygroundPageLayout>
  );
}
