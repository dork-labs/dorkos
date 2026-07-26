import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { CHAT_SECTIONS } from '../playground-registry';
import { MessageShowcases } from '../showcases/MessageShowcases';
import { ToolShowcases } from '../showcases/ToolShowcases';
import { InputShowcases } from '../showcases/InputShowcases';
import { StatusShowcases } from '../showcases/StatusShowcases';
import { StatusLineShowcases } from '../showcases/StatusLineShowcases';
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
      <InputShowcases />
      <StatusShowcases />
      <StatusLineShowcases />
      <SessionInspectorShowcases />
      <MiscShowcases />
    </PlaygroundPageLayout>
  );
}
