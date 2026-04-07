import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { SETTINGS_SECTIONS } from '../playground-registry';
import { SettingsShowcases } from '../showcases/SettingsShowcases';

/** Settings dialog showcase page for the dev playground. */
export function SettingsPage() {
  return (
    <PlaygroundPageLayout
      title="Settings"
      description="Settings dialogs, individual tabs, mobile drill-in, loading and empty states, and the underlying primitives."
      sections={SETTINGS_SECTIONS}
    >
      <SettingsShowcases />
    </PlaygroundPageLayout>
  );
}
