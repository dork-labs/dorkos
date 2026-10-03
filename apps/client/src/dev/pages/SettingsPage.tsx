import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { SETTINGS_SECTIONS } from '../playground-registry';
import { SettingsShowcases } from '../showcases/SettingsShowcases';
import { RemoteAccessShowcases } from '../showcases/RemoteAccessShowcases';
import { RuntimeCardShowcases } from '../showcases/RuntimeCardShowcases';
import { CloudUsageShowcases } from '../showcases/CloudUsageShowcases';
import { CreditsOfferShowcases } from '../showcases/CreditsOfferShowcases';

/** Settings dialog showcase page for the dev playground. */
export function SettingsPage() {
  return (
    <PlaygroundPageLayout
      title="Settings"
      description="Settings dialogs, individual tabs, the Runtimes tab's cards in every state they can reach, the connect step that offers DorkOS credits first, mobile drill-in, loading and empty states, the credits card on a linked account, and the underlying primitives."
      sections={SETTINGS_SECTIONS}
    >
      <RuntimeCardShowcases />
      <CreditsOfferShowcases />
      <SettingsShowcases />
      <RemoteAccessShowcases />
      <CloudUsageShowcases />
    </PlaygroundPageLayout>
  );
}
