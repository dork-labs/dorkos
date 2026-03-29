import { Users } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import type { SubagentInfo } from '@dorkos/shared/types';

interface SubagentsItemProps {
  subagents: SubagentInfo[];
}

/** Status bar item displaying available subagent count with a tooltip listing them. */
export function SubagentsItem({ subagents }: SubagentsItemProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1">
          <Users className="size-(--size-icon-xs)" />
          <span>
            {subagents.length} agent{subagents.length !== 1 ? 's' : ''}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <ul className="space-y-1">
          {subagents.map((a) => (
            <li key={a.name}>
              <span className="font-medium">{a.name}</span>
              {a.model && (
                <span className="text-muted-foreground ml-1 text-[10px]">({a.model})</span>
              )}
              <p className="text-muted-foreground line-clamp-1 text-[10px] leading-tight">
                {a.description}
              </p>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
