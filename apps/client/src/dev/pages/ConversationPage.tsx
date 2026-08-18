import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { CONVERSATION_SECTIONS } from '../playground-registry';
import { MessageShowcases } from '../showcases/MessageShowcases';
import { ToolShowcases } from '../showcases/ToolShowcases';
import { AskShowcases } from '../showcases/AskShowcases';
import { ChipShowcases } from '../showcases/ChipShowcases';
import { InputShowcases } from '../showcases/InputShowcases';
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
      <MessageShowcases />
      <ToolShowcases />
      <AskShowcases />
      <ChipShowcases />
      <InputShowcases />
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
