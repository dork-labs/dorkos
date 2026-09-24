import { ScrollArea, ScrollBar } from '@dork-labs/ui';
import { Section, Demo, DemoLabel } from './example-layout';

/** Production examples moved with their shared primitives. */
export function ScrollExamples() {
  return (
    <>
      <Section
        id="scroll-area"
        title="ScrollArea"
        description="Custom scrollbar container for overflowing content."
      >
        <DemoLabel>Vertical</DemoLabel>
        <Demo>
          <ScrollArea className="border-dui-border h-48 w-full rounded-md border">
            <div className="p-4">
              {Array.from({ length: 20 }, (_, i) => (
                <div key={i} className="border-dui-border border-b py-2 text-sm">
                  Session {i + 1} — agent-{String(i + 1).padStart(3, '0')}
                </div>
              ))}
            </div>
          </ScrollArea>
        </Demo>

        <DemoLabel>Horizontal</DemoLabel>
        <Demo>
          <ScrollArea className="border-dui-border w-full rounded-md border whitespace-nowrap">
            <div className="flex gap-4 p-4">
              {Array.from({ length: 12 }, (_, i) => (
                <div
                  key={i}
                  className="border-dui-border bg-dui-muted flex h-20 w-36 shrink-0 items-center justify-center rounded-md border text-sm"
                >
                  Agent {i + 1}
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </Demo>
      </Section>
    </>
  );
}
