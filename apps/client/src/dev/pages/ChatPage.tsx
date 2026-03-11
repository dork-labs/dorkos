import { MessageShowcases } from '../showcases/MessageShowcases';
import { ToolShowcases } from '../showcases/ToolShowcases';
import { InputShowcases } from '../showcases/InputShowcases';
import { StatusShowcases } from '../showcases/StatusShowcases';
import { MiscShowcases } from '../showcases/MiscShowcases';

/** Chat component showcase page for the dev playground. */
export function ChatPage() {
  return (
    <>
      <header className="border-border border-b px-6 py-4">
        <h1 className="text-xl font-bold">Chat Components</h1>
        <p className="text-muted-foreground text-sm">
          Visual testing gallery for chat UI components.
        </p>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 p-6">
        <MessageShowcases />
        <ToolShowcases />
        <InputShowcases />
        <StatusShowcases />
        <MiscShowcases />
      </main>
    </>
  );
}
