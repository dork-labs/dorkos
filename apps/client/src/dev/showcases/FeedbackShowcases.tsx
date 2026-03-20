import { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { toast } from 'sonner';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Skeleton,
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
} from '@/layers/shared/ui';

/** Feedback component showcases: Skeleton, Separator, Tooltip, HoverCard, Collapsible, Toaster. */
export function FeedbackShowcases() {
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);

  return (
    <>
      <PlaygroundSection title="Skeleton" description="Loading placeholder with animated pulse.">
        <ShowcaseDemo>
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Separator" description="Horizontal and vertical dividers.">
        <ShowcaseLabel>Horizontal</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="space-y-3">
            <p className="text-foreground text-sm">Content above</p>
            <Separator />
            <p className="text-foreground text-sm">Content below</p>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Vertical</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex h-6 items-center gap-3">
            <span className="text-foreground text-sm">Left</span>
            <Separator orientation="vertical" />
            <span className="text-foreground text-sm">Right</span>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Tooltip" description="Hover to reveal contextual information.">
        <ShowcaseDemo>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Hover me</Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>This is a tooltip</p>
            </TooltipContent>
          </Tooltip>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="HoverCard"
        description="Content card revealed on hover over a trigger."
      >
        <ShowcaseDemo>
          <HoverCard>
            <HoverCardTrigger asChild>
              <Button variant="link">@claude-code</Button>
            </HoverCardTrigger>
            <HoverCardContent className="w-72">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold">Claude Code Runtime</h4>
                <p className="text-muted-foreground text-xs">
                  Primary agent runtime backed by the Claude Agent SDK. Supports streaming, tool
                  approval, and extended thinking.
                </p>
                <div className="text-muted-foreground flex items-center gap-2 pt-1 text-xs">
                  <span>v2.1.0</span>
                  <Separator orientation="vertical" className="h-3" />
                  <span>42 sessions active</span>
                </div>
              </div>
            </HoverCardContent>
          </HoverCard>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Collapsible"
        description="Expand/collapse toggle for supplementary content."
      >
        <ShowcaseDemo>
          <Collapsible
            open={collapsibleOpen}
            onOpenChange={setCollapsibleOpen}
            className="space-y-2"
          >
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold">Agent Configuration</h4>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                  <ChevronsUpDown className="size-4" />
                  <span className="sr-only">Toggle</span>
                </Button>
              </CollapsibleTrigger>
            </div>
            <div className="rounded-md border px-3 py-2 text-sm">Runtime: Claude Code</div>
            <CollapsibleContent className="space-y-2">
              <div className="rounded-md border px-3 py-2 text-sm">Max tokens: 8192</div>
              <div className="rounded-md border px-3 py-2 text-sm">Temperature: 0.7</div>
            </CollapsibleContent>
          </Collapsible>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Toaster" description="Toast notifications via Sonner.">
        <ShowcaseDemo>
          {/* Toasts render via the global <Toaster /> in App.tsx */}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => toast.success('Agent deployed successfully')}>
              Success
            </Button>
            <Button variant="outline" onClick={() => toast.error('Failed to connect to runtime')}>
              Error
            </Button>
            <Button variant="outline" onClick={() => toast.info('Session sync in progress')}>
              Info
            </Button>
            <Button variant="outline" onClick={() => toast.warning('Rate limit approaching')}>
              Warning
            </Button>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
