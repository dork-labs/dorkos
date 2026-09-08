/**
 * What each agent tool cannot see, and the plan's own sentence about why.
 *
 * @module entities/harness/ui/NotSharedPanel
 */
import { useState } from 'react';
import type { HarnessId, HarnessRow } from '@dorkos/shared/harness-schemas';
import { Badge, CollapsibleFieldCard } from '@/layers/shared/ui';
import { groupDropsByHarness, type HarnessDropGroup } from '../lib/harness-status';

/** What a {@link NotSharedPanel} draws. */
export interface NotSharedPanelProps {
  /** Every file in the status. The groups are built from these.  */
  rows: readonly HarnessRow[];
  /** The enabled tools, in manifest order. */
  enabled: readonly HarnessId[];
}

/** One tool's panel, holding its own open state. */
function DropPanel({ group }: { group: HarnessDropGroup }) {
  const [open, setOpen] = useState(false);

  return (
    <CollapsibleFieldCard
      open={open}
      onOpenChange={setOpen}
      trigger={<span className="text-xs">Not shared with {group.label}</span>}
      badge={
        <Badge variant="secondary" size="xs">
          {group.entries.length}
        </Badge>
      }
    >
      <ul className="space-y-2 px-4 pb-3">
        {group.entries.map((entry) => (
          <li key={entry.key} className="flex flex-col gap-0.5">
            <span className="text-3xs font-medium">
              {entry.artifact} {entry.name}
            </span>
            {entry.reason !== undefined && (
              <span className="text-muted-foreground text-3xs">{entry.reason}</span>
            )}
          </li>
        ))}
      </ul>
    </CollapsibleFieldCard>
  );
}

/**
 * One collapsed panel per enabled tool that is missing something.
 *
 * **Every reason is repeated here in full, verbatim.** This is the honesty gate:
 * `dorkos harness sync` prints these same strings, so a paraphrase would leave
 * two surfaces describing one fact in two voices with no way to tell which is
 * current. It is also why the chip's tooltip is never the only copy of a
 * sentence — a tooltip is not reachable by everyone, and a reason a person
 * cannot read is a reason that was not given.
 *
 * Collapsed by default: on a real repository this is sixteen entries under one
 * tool and nine under another, and a page that opened with them expanded would
 * bury the list it exists to show. A tool with nothing missing gets no panel at
 * all, so a project running Codex alone is never shown an empty Cursor heading.
 */
export function NotSharedPanel({ rows, enabled }: NotSharedPanelProps) {
  const groups = groupDropsByHarness(rows, enabled);
  if (groups.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {groups.map((group) => (
        <DropPanel key={group.harness} group={group} />
      ))}
    </div>
  );
}
