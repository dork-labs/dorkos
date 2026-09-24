/**
 * What changed since a waiting schedule was last approved, in words a person
 * reads on the approval card (DOR-2323).
 *
 * @module features/schedule-approval/lib/describe-approval-changes
 */
import type { Task } from '@dorkos/shared/types';

/** One line of the card's "what changed" list. */
export interface ApprovalChangeLine {
  /** What changed, as the card names it. */
  label: string;
  /** The approved value, or `null` when the line says only that it changed. */
  from: string | null;
  /** The value that would run now. */
  to: string;
}

type Change = Task['approvalChanges'][number];

/** The card's name for each part of the approved work. */
const LABEL: Record<Change['field'], string> = {
  prompt: 'Instructions',
  cron: 'Schedule',
  timezone: 'Timezone',
  name: 'Name',
  runtime: 'Runtime',
  model: 'Model',
  effort: 'Effort',
  maxRuntime: 'Time limit',
  sticky: 'Remembers earlier runs',
};

/** A duration in milliseconds the way the schedule form writes it (`2h`, `30m`, `45s`). */
function formatDuration(ms: number): string {
  const units = [
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1_000],
  ] as const;
  for (const [unit, size] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/** One value of one part, in words. */
function formatValue(field: Change['field'], value: Change['from']): string {
  if (field === 'sticky') return value === true ? 'yes' : 'no';
  if (field === 'maxRuntime')
    return typeof value === 'number' ? formatDuration(value) : 'the default';
  if (value === null || value === '') {
    // A null runtime, model or effort follows the agent; an empty cron runs on demand.
    return field === 'cron' ? 'only when run by hand' : 'the agent’s own';
  }
  return String(value);
}

/**
 * The card's lines for a schedule's `approvalChanges`, in the order the server
 * lists them. The instructions are not quoted: the full prompt is one click
 * away on the card, and two long texts side by side say less than "changed".
 *
 * @param changes - What changed, from the task.
 */
export function describeApprovalChanges(changes: Task['approvalChanges']): ApprovalChangeLine[] {
  return changes.map((change) =>
    change.field === 'prompt'
      ? { label: LABEL.prompt, from: null, to: 'changed (see below)' }
      : {
          label: LABEL[change.field],
          from: formatValue(change.field, change.from),
          to: formatValue(change.field, change.to),
        }
  );
}
