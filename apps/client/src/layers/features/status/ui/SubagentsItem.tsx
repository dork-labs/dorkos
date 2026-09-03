import { Users } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import type { ActiveSubagent } from '../model/session-diagnostics';

interface SubagentsItemProps {
  /**
   * How many helpers are running, as the SERVER counts them.
   *
   * The number drawn, and deliberately not `running.length`: a background task
   * outlives the turn that started it, and after that turn's history reloads the
   * only thing left that can name it is gone (DOR-1100). The count survives; the
   * rows do not.
   */
  count: number;
  /**
   * The running helpers this turn can still NAME, for the tooltip —
   * `partitionSubagents`' `running` half, never the whole fold (which keeps
   * terminal rows) and never the runtime's catalogue of callable agent types.
   * May be shorter than {@link count}, and empty is normal once the turn that
   * started them has closed.
   */
  running: readonly ActiveSubagent[];
  /**
   * True when the agent itself has stopped talking and these are what remain.
   *
   * The same number means two different things either side of this flag: during
   * a turn it is work being done alongside the agent, and afterwards it is the
   * reason the session looks finished when it is not.
   */
  waiting: boolean;
}

/**
 * Status line item: how many helper agents are working right now.
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
 * The glyph never changes, the number never animates, and the accessible name
 * keeps ONE phrasing across a turn boundary — only the count in it changes. The
 * row is `aria-live="polite"`, so re-wording the same fact when the turn ends
 * would announce a change to a screen reader that nothing actually changed for.
 * The extra context that only applies once the agent has stopped talking lives
 * in the tooltip instead.
 *
 * That tooltip is unreachable on touch, and deliberately gains no second surface
 * here: the registry already gives this item `group: 'diagnostics'`, so the
 * count keeps its own row in the Session popover behind the line's `⋯` — the
 * same pattern every other item uses when the bar is too narrow to be the whole
 * story. A new mobile affordance for one sentence would be a worse trade than
 * the row that already exists.
 *
 * @param props - The count, the rows that can be named, and whether the agent is
 *   waiting on them.
 */
export function SubagentsItem({ count, running, waiting }: SubagentsItemProps) {
  const plural = count === 1 ? '' : 's';
  const unnamed = count - running.length;
  // One phrasing, whatever the turn is doing — see the note above.
  const label = `${count} subagent${plural} running`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* No `role="status"`: the row itself is already `aria-live="polite"`
            (see `StatusLine`), and a live region inside a live region can
            announce the same change twice. */}
        <span className="inline-flex min-w-0 items-center gap-1" aria-label={label}>
          <Users className="size-(--size-icon-xs) shrink-0" />
          {/* No `truncate`: an ellipsis costs width, so a squeezed two-digit
              count renders as one digit with the ellipsis itself clipped — a
              confident wrong number rather than a visibly cut one. The item is
              rigid instead, so it is never asked. */}
          <span className="shrink-0 tabular-nums">{count}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {/* The one line that explains why the session looks finished and isn't.
            Only when it is true — during a turn this would be noise. */}
        {waiting && (
          <p className="mb-1 font-medium">
            Still working in the background. The agent picks up again when they finish.
          </p>
        )}
        <ul className="space-y-1">
          {running.map((subagent) => (
            <li key={subagent.taskId}>
              {/* Never the raw `taskId` — a runtime that sends no description should
                  cost the reader a vague line, not a piece of DorkOS's plumbing. */}
              <span className="font-medium">{subagent.description ?? 'Working…'}</span>
              <p className="text-muted-foreground text-3xs leading-tight">
                {subagent.toolUses ?? 0} tool{subagent.toolUses === 1 ? '' : 's'}
                {subagent.lastToolName ? ` · last ${subagent.lastToolName}` : ''}
              </p>
            </li>
          ))}
        </ul>
        {/* Says "there are more than I can name" rather than pretending the list
            is the whole story — the rows are per-turn, the count is not. */}
        {unnamed > 0 && (
          <p className="text-muted-foreground text-3xs leading-tight">
            {running.length > 0 ? `and ${unnamed} more` : `${unnamed} task${plural} from earlier`}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
