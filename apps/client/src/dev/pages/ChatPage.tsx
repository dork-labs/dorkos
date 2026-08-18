import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { CHAT_SECTIONS } from '../playground-registry';
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

/** Chat component showcase page for the dev playground. */
export function ChatPage() {
  return (
    <PlaygroundPageLayout
      title="Chat Components"
      description="Visual testing gallery for chat UI components."
      sections={CHAT_SECTIONS}
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
