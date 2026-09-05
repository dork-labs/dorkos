import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { FEATURE_AGENT_SECTIONS, FEATURE_SURFACE_SECTIONS } from '../playground-registry';
import { AgentSidebarShowcases } from '../showcases/AgentSidebarShowcases';
import { SidebarChromeShowcases } from '../showcases/SidebarChromeShowcases';
import { JumpBackInShowcases } from '../showcases/JumpBackInShowcases';
import { AgentFleetShowcases } from '../showcases/AgentFleetShowcases';
import { RelayShowcases } from '../showcases/RelayShowcases';
import { AdapterWizardShowcases } from '../showcases/AdapterWizardShowcases';
import { MeshShowcases } from '../showcases/MeshShowcases';
import { TasksShowcases } from '../showcases/TasksShowcases';
import { PersonalityPickerShowcases } from '../showcases/PersonalityPickerShowcases';
import { PulsePanelShowcase } from '../showcases/PulsePanelShowcases';
import { PipPanelShowcases } from '../showcases/PipPanelShowcases';
import { ApprovalsShowcases } from '../showcases/ApprovalsShowcases';
import { ScheduleApprovalShowcases } from '../showcases/ScheduleApprovalShowcases';
import { TriageHeaderShowcases } from '../showcases/TriageHeaderShowcases';
import { InboxShowcases } from '../showcases/InboxShowcases';
import { PresenceStripShowcases } from '../showcases/PresenceStripShowcases';
import { HomeStatesShowcases } from '../showcases/HomeStatesShowcases';
import { ConnectionsShowcases } from '../showcases/ConnectionsShowcases';
import { McpServerCardShowcases } from '../showcases/McpServerCardShowcases';

/**
 * Agent & Relay showcase page for the dev playground.
 *
 * An agent and the network it lives in — the half of the former "Subsystems"
 * page that stayed at `/dev/features`. Split from the surfaces a person
 * answers things on ({@link HomeInboxPage}) at DOR-1766, batch 20 audit
 * finding 20.2: the combined page had already outgrown its section data file
 * (46 sections, twice the ~20 the rest of the playground settles around) and
 * the data file had been split along this exact seam, but the page itself
 * never followed.
 *
 * **Shares this file with {@link HomeInboxPage}**, the only exception to the
 * playground's one-page-one-file convention: `dev/pages/` was already at the
 * repo's 25-file-per-directory cap (`scripts/check-dir-size.sh`), and a
 * second new file would have blocked the commit that added it. Splitting
 * `dev/pages/` into subdirectories to make room was judged out of scope for
 * this batch — a repo-wide restructure, not a playground-organization fix —
 * so the two pages this split produced stay co-located instead.
 */
export function FeaturesPage() {
  return (
    <PlaygroundPageLayout
      title="Agent & Relay"
      description="An agent and the network it lives in — sidebar chrome, the fleet table, Relay adapters, Mesh, and Tasks."
      sections={FEATURE_AGENT_SECTIONS}
    >
      <PersonalityPickerShowcases />
      <SidebarChromeShowcases />
      <AgentSidebarShowcases />
      <JumpBackInShowcases />
      <AgentFleetShowcases />
      <RelayShowcases />
      <AdapterWizardShowcases />
      <MeshShowcases />
      <TasksShowcases />
      <PulsePanelShowcase />
    </PlaygroundPageLayout>
  );
}

/**
 * Home, Inbox & Approvals showcase page for the dev playground.
 *
 * The surfaces a person answers things on — the half of the former
 * "Subsystems" page that used to share `/dev/features` with {@link FeaturesPage}.
 * Split out at DOR-1766, batch 20 audit finding 20.2 (see {@link FeaturesPage}
 * for why, and for why this page's component lives in the same file).
 * `ApprovalCard` also renders on the Conversation page, cross-listed rather
 * than re-registered — see `CONVERSATION_CROSS_LISTED` in
 * `playground-config.ts`.
 */
export function HomeInboxPage() {
  return (
    <PlaygroundPageLayout
      title="Home, Inbox & Approvals"
      description="The surfaces a person answers things on — approvals, the inbox, presence, connections, MCP servers, and Home itself."
      sections={FEATURE_SURFACE_SECTIONS}
    >
      <PipPanelShowcases />
      <ApprovalsShowcases />
      <ScheduleApprovalShowcases />
      <TriageHeaderShowcases />
      <InboxShowcases />
      <PresenceStripShowcases />
      <HomeStatesShowcases />
      <ConnectionsShowcases />
      <McpServerCardShowcases />
    </PlaygroundPageLayout>
  );
}
