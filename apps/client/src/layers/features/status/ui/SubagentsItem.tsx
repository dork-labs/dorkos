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
 * The value is the bare count beside the glyph — `2`, not `2 running` — which is
 * the same shape every other number in the line takes (`▤ 88%`, `$1.23`). Two
 * characters are also cheap enough to protect: the registry marks this item rigid,
 * so the row never squeezes it and the count is never partly drawn. The word is in
 * the tooltip and in the accessible name, where a narrow row cannot cut it.
 *
 * @param props - The running subagents.
 */
export function SubagentsItem({ running }: SubagentsItemProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* No `role="status"`: the row itself is already `aria-live="polite"`
            (see `StatusLine`), and a live region inside a live region can
            announce the same change twice. */}
        <span
          className="inline-flex min-w-0 items-center gap-1"
          aria-label={`${running.length} subagent${running.length === 1 ? '' : 's'} running`}
        >
          <Users className="size-(--size-icon-xs) shrink-0" />
          {/* No `truncate`: an ellipsis costs width, so a squeezed two-digit
              count renders as one digit with the ellipsis itself clipped — a
              confident wrong number rather than a visibly cut one. The item is
              rigid instead, so it is never asked. */}
          <span className="shrink-0 tabular-nums">{running.length}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <ul className="space-y-1">
          {running.map((subagent) => (
            <li key={subagent.taskId}>
              {/* Never the raw `taskId` — a runtime that sends no description should
                  cost the reader a vague line, not a piece of DorkOS's plumbing. */}
              <span className="font-medium">{subagent.description ?? 'Working…'}</span>
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
