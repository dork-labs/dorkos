import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

interface ToolCountBadgeProps {
  tools: readonly string[];
  implicitNote?: string;
}

/** Badge showing tool count that reveals the full tool list on hover. */
export function ToolCountBadge({ tools, implicitNote }: ToolCountBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge tone="neutral" variant="outline" className="shrink-0 cursor-default font-normal">
          {tools.length}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="font-mono text-xs">{tools.join(', ')}</p>
        {implicitNote && <p className="text-muted-foreground mt-1 text-xs">{implicitNote}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
