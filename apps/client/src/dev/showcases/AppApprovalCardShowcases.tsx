/**
 * The approval card for apps that run in their own frame (DOR-3293), drawn
 * without a server, with made-up apps: one that changes things and uses other
 * apps, and one that can change nothing at all.
 *
 * Built from the same `InboxDecisionRow` and `ExtensionPermissionLines` the
 * inbox renders, so these cannot drift into a replica.
 *
 * @module dev/showcases/AppApprovalCardShowcases
 */
import { Puzzle } from 'lucide-react';
import { InboxDecisionRow } from '@/layers/features/inbox';
import {
  ExtensionPermissionLines,
  type ExtensionPermissionView,
} from '@/layers/entities/extension';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** A made-up app whose screens change things and use three other apps. */
const WRITER: ExtensionPermissionView = {
  runtime: 'in-process',
  net: [],
  run: [],
  agents: false,
  hasServer: false,
  hasPage: true,
  writes: ['data', 'canvas', 'inbox', 'work', 'files', 'rooms'],
  apps: [
    { id: 'ledger', name: 'Ledger', access: 'reads' },
    { id: 'desk', name: 'Desk', access: 'both' },
    { id: 'orbit', name: null, access: null },
  ],
};

/** A made-up app that can change nothing at all. */
const QUIET: ExtensionPermissionView = {
  runtime: 'in-process',
  net: [],
  run: [],
  agents: false,
  hasServer: false,
  hasPage: false,
  writes: [],
};

const ACTIONS = {
  kind: 'yes-no',
  approveLabel: 'Allow',
  rejectLabel: 'Not now',
  onApprove: () => {},
  onReject: () => {},
} as const;

/** One approval card, as the inbox draws it. */
function Card({
  title,
  why,
  permissions,
}: {
  title: string;
  why: string;
  permissions: ExtensionPermissionView;
}) {
  return (
    <div className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2">
      <InboxDecisionRow
        icon={Puzzle}
        title={title}
        why={why}
        details={<ExtensionPermissionLines permissions={permissions} />}
        actions={ACTIONS}
      />
    </div>
  );
}

/** The two card fixtures the designer asked to see. */
export function AppApprovalCardShowcases() {
  return (
    <PlaygroundSection
      title="App approval card"
      description="What an app's screens can change, and the other apps it uses, in DorkOS's own words."
    >
      <ShowcaseLabel>An app that changes things and uses other apps</ShowcaseLabel>
      <ShowcaseDemo>
        <Card
          title="Quarterly report wants to run on this computer."
          why="Quarterly report was added to DorkOS. It builds a report from your books and notes."
          permissions={WRITER}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>An app that can change nothing</ShowcaseLabel>
      <ShowcaseDemo>
        <Card
          title="Clock wants to run on this computer."
          why="Clock was added to DorkOS. It shows the time in three cities."
          permissions={QUIET}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
