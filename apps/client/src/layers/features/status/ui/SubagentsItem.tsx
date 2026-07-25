import { Users } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import type { ActiveSubagent } from '../model/session-diagnostics';

interface SubagentsItemProps {
  /**
   * The subagents still in flight — `partitionSubagents`' `running` half, never
   * the whole fold (which keeps terminal rows) and never the runtime's catalogue
   * of callable agent types.
   */
  running: readonly ActiveSubagent[];
}

/**
 * Status line item: how many helper agents are working on this turn.
 *
 * It counts what is *running*, which is the only reading that can earn a slot in
 * a quiet-by-default line. The runtime's catalogue of callable agent types is a
 * fixed list — counting that never changes and so never says anything, which is
 * what put a permanent "12 agents" in the line (DOR-462). The catalogue lives in
 * the Session panel under "Available" instead.
 *
 * @param props - The running subagents.
 */
export function SubagentsItem({ running }: SubagentsItemProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Deliberately unnamed: `role="status"` is a live region, so a screen
            reader announces the CONTENT as the count changes. */}
        <span className="inline-flex min-w-0 items-center gap-1" role="status">
          <Users className="size-(--size-icon-xs) shrink-0" />
          <span className="truncate">{running.length} running</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <ul className="space-y-1">
          {running.map((subagent) => (
            <li key={subagent.taskId}>
              <span className="font-medium">{subagent.description ?? subagent.taskId}</span>
              <p className="text-muted-foreground text-[10px] leading-tight">
                {subagent.toolUses ?? 0} tool{subagent.toolUses === 1 ? '' : 's'}
                {subagent.lastToolName ? ` · last ${subagent.lastToolName}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
