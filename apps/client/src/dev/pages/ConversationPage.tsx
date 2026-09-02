import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { CONVERSATION_SECTIONS } from '../playground-registry';
import { SurfacesShowcase } from '../showcases/SurfacesShowcases';
import { MessageShowcases } from '../showcases/MessageShowcases';
import { TimelineShowcase } from '../showcases/TimelineShowcases';
import { ToolShowcases } from '../showcases/ToolShowcases';
import { AsksShowcase } from '../showcases/AsksShowcases';
import { ApprovalCardShowcase } from '../showcases/ApprovalsShowcases';
import { ChipShowcases } from '../showcases/ChipShowcases';
import {
  ComposerShowcases,
  CommandPaletteShowcase,
  QuestionPromptShowcase,
} from '../showcases/ComposerShowcases';
import { StatusShowcases } from '../showcases/StatusShowcases';
import { LiveLaneShowcase, LivePeekShowcase } from '../showcases/LiveLaneShowcases';
import { StatusLineShowcases } from '../showcases/StatusLineShowcases';
import { ModelPickerShowcases } from '../showcases/ModelPickerShowcases';
import { TrustDialShowcases } from '../showcases/TrustDialShowcases';
import { SessionInspectorShowcases } from '../showcases/SessionInspectorShowcases';
import { MiscShowcases } from '../showcases/MiscShowcases';

/** Conversation compound showcase page for the dev playground. */
export function ConversationPage() {
  return (
    <PlaygroundPageLayout
      title="Conversation"
      description="The Conversation compound every messaging surface composes — session, room and DM."
      sections={CONVERSATION_SECTIONS}
    >
      <SurfacesShowcase />
      <MessageShowcases />
      <TimelineShowcase />
      <ToolShowcases />
      <AsksShowcase />
      <ChipShowcases />
      <ComposerShowcases />
      <CommandPaletteShowcase />
      <QuestionPromptShowcase />
      <StatusShowcases />
      <LiveLaneShowcase />
      <LivePeekShowcase />
      <StatusLineShowcases />
      <ModelPickerShowcases />
      <TrustDialShowcases />
      <SessionInspectorShowcases />
      <MiscShowcases />
      {/* Borrowed, not registered: Subsystems owns this section's entry and its
          canonical `/dev/features#approvalcard` anchor, and Conversation renders
          it per CONVERSATION_CROSS_LISTED. At page level like IdentityPage's
          borrows, and last, because that is where the page's own TOC lists it —
          nesting it inside Asks drew a section card inside a section card and
          buried its anchor mid-section. */}
      <ApprovalCardShowcase />
    </PlaygroundPageLayout>
  );
}
