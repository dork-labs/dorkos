import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import {
  Skeleton,
  Separator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Button,
} from '@/layers/shared/ui';

/** Feedback component showcases: Skeleton, Separator, Tooltip. */
export function FeedbackShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Skeleton"
        description="Loading placeholder with animated pulse."
      >
        <div className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="Separator"
        description="Horizontal and vertical dividers."
      >
        <ShowcaseLabel>Horizontal</ShowcaseLabel>
        <div className="space-y-3">
          <p className="text-foreground text-sm">Content above</p>
          <Separator />
          <p className="text-foreground text-sm">Content below</p>
        </div>

        <ShowcaseLabel>Vertical</ShowcaseLabel>
        <div className="flex h-6 items-center gap-3">
          <span className="text-foreground text-sm">Left</span>
          <Separator orientation="vertical" />
          <span className="text-foreground text-sm">Right</span>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="Tooltip"
        description="Hover to reveal contextual information."
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Hover me</Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>This is a tooltip</p>
          </TooltipContent>
        </Tooltip>
      </PlaygroundSection>
    </>
  );
}
