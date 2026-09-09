/**
 * What is true about the project rather than about any one agent tool.
 *
 * @module entities/harness/ui/ProjectLevelNoticesPanel
 */
import { useState } from 'react';
import type { HarnessProjectEntry } from '@dorkos/shared/harness-schemas';
import { cn } from '@/layers/shared/lib/utils';
import { Badge, CollapsibleFieldCard } from '@/layers/shared/ui';
import { projectEntryCountLabel, projectEntryHeading } from '../lib/harness-status';

/** What a {@link ProjectLevelNoticesPanel} draws. */
export interface ProjectLevelNoticesPanelProps {
  /** The status's project-level entries. Nothing is drawn when there are none. */
  entries: readonly HarnessProjectEntry[];
}

/**
 * The entries that belong to no tool's column, in one collapsed panel.
 *
 * All four kinds are drawn — a `drop` that fits nowhere, a `warning` about a
 * file the engine could not use, a `write` a sync will make that belongs to no
 * single tool, and a `notice` about the manifest itself. Each is
 * `<kind> · <artifact> <name>` with the engine's own sentence under it,
 * unchanged.
 *
 * **The count carries its unit**, for the reason the drop panels' does: nothing
 * here is a skill, and a bare number beside a page titled Skills reads as one.
 *
 * **A `notice` reads as a notice.** It is drawn muted and carries no tool name,
 * because it is about `.agents/harness.manifest.json` — a retired key, or a hook
 * policy naming a tool this manifest does not enable — and filing it under a
 * heading would tell somebody who runs Codex alone that Claude Code has a
 * problem. That is the whole reason this panel exists beside the per-tool ones,
 * and it mirrors the `plugin layers:` heading the terminal already prints.
 */
export function ProjectLevelNoticesPanel({ entries }: ProjectLevelNoticesPanelProps) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  return (
    <CollapsibleFieldCard
      open={open}
      onOpenChange={setOpen}
      trigger={<span className="text-xs">Project-level notices</span>}
      badge={
        <Badge variant="secondary" size="xs" className="whitespace-nowrap">
          {projectEntryCountLabel(entries.length)}
        </Badge>
      }
    >
      <ul className="space-y-2 px-4 pb-3">
        {entries.map((entry) => (
          <li
            key={`${entry.kind} ${entry.artifact} ${entry.source ?? ''} ${entry.name}`}
            className="flex flex-col gap-0.5"
          >
            <span
              className={cn(
                'text-3xs font-medium',
                entry.kind === 'notice' && 'text-muted-foreground font-normal'
              )}
            >
              {projectEntryHeading(entry)}
            </span>
            <span className="text-muted-foreground text-3xs">{entry.reason}</span>
          </li>
        ))}
      </ul>
    </CollapsibleFieldCard>
  );
}
