import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { CONVERSATION_SECTIONS } from '../playground-registry';
import { SurfacesShowcase } from '../showcases/SurfacesShowcases';
import { MessageShowcases } from '../showcases/MessageShowcases';
import { TimelineShowcase } from '../showcases/TimelineShowcases';
import { ToolShowcases } from '../showcases/ToolShowcases';
import { AsksShowcase } from '../showcases/AsksShowcases';
import { ChipShowcases } from '../showcases/ChipShowcases';
import {
  ComposerShowcases,
  CommandPaletteShowcase,
  QuestionPromptShowcase,
} from '../showcases/ComposerShowcases';
import { StatusShowcases } from '../showcases/StatusShowcases';
import { LiveLaneShowcase, LivePeekShowcase } from '../showcases/LiveLaneShowcases';
import { StatusLineShowcases } from '../showcases/StatusLineShowcases';
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
      <TrustDialShowcases />
      <SessionInspectorShowcases />
      <MiscShowcases />
    </PlaygroundPageLayout>
  );
}
