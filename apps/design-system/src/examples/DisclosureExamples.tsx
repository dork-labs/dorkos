import { useState } from 'react';
import {
  Separator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Button,
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  TooltipProvider,
} from '@dork-labs/ui';
import { Section, Demo, DemoLabel } from './example-layout';

/** Production examples moved with their shared primitives. */
export function DisclosureExamples() {
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  return (
    <>
      <TooltipProvider>
        <Section id="separator" title="Separator" description="Horizontal and vertical dividers.">
          <DemoLabel>Horizontal</DemoLabel>
          <Demo>
            <div className="space-y-3">
              <p className="text-dui-foreground text-sm">Content above</p>
              <Separator />
              <p className="text-dui-foreground text-sm">Content below</p>
            </div>
          </Demo>

          <DemoLabel>Vertical</DemoLabel>
          <Demo>
            <div className="flex h-6 items-center gap-3">
              <span className="text-dui-foreground text-sm">Left</span>
              <Separator orientation="vertical" />
              <span className="text-dui-foreground text-sm">Right</span>
            </div>
          </Demo>
        </Section>
        <Section id="tooltip" title="Tooltip" description="Hover to reveal contextual information.">
          <Demo>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline">Hover me</Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>This is a tooltip</p>
              </TooltipContent>
            </Tooltip>
          </Demo>
        </Section>
        <Section
          id="hover-card"
          title="HoverCard"
          description="Content card revealed on hover over a trigger."
        >
          <Demo>
            <HoverCard>
              <HoverCardTrigger asChild>
                <Button variant="link">@claude-code</Button>
              </HoverCardTrigger>
              <HoverCardContent className="w-72">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold">Claude Code Runtime</h4>
                  <p className="text-dui-muted-foreground text-xs">
                    Primary agent runtime backed by the Claude Agent SDK. Supports streaming, tool
                    approval, and extended thinking.
                  </p>
                  <div className="text-dui-muted-foreground flex items-center gap-2 pt-1 text-xs">
                    <span>v2.1.0</span>
                    <Separator orientation="vertical" className="h-3" />
                    <span>42 sessions active</span>
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
          </Demo>
        </Section>
        <Section
          id="collapsible"
          title="Collapsible"
          description="Expand/collapse toggle for supplementary content."
        >
          <Demo>
            <Collapsible
              open={collapsibleOpen}
              onOpenChange={setCollapsibleOpen}
              className="space-y-2"
            >
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold">Agent Configuration</h4>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                    <span aria-hidden="true">↕</span>
                    <span className="sr-only">Toggle</span>
                  </Button>
                </CollapsibleTrigger>
              </div>
              <div className="border-dui-border rounded-md border px-3 py-2 text-sm">
                Runtime: Claude Code
              </div>
              <CollapsibleContent className="space-y-2">
                <div className="border-dui-border rounded-md border px-3 py-2 text-sm">
                  Max tokens: 8192
                </div>
                <div className="border-dui-border rounded-md border px-3 py-2 text-sm">
                  Temperature: 0.7
                </div>
              </CollapsibleContent>
            </Collapsible>
          </Demo>
        </Section>
      </TooltipProvider>
    </>
  );
}
