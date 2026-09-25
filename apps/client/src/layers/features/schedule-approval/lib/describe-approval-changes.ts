/**
 * What changed since a waiting schedule was last approved, in words a person
 * reads on the approval card (DOR-2323).
 *
 * @module features/schedule-approval/lib/describe-approval-changes
 */
import type { Task } from '@dorkos/shared/types';
import { formatCadence } from './format-schedule-times';

/** One line of the card's "what changed" list. */
export interface ApprovalChangeLine {
  /** What changed, as the card names it. */
  label: string;
  /** The approved value, or `null` when the line says only that it changed. */
  from: string | null;
  /** The value that would run now. */
  to: string;
  /**
   * Whether the values are single terms the card keeps whole (a model name, a
   * runtime, a limit), never broken at a hyphen. Sentences (a cadence, the
   * instructions note) wrap like any text.
   */
  unbroken: boolean;
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

/** The card's name for a part of the agent the schedule follows (DOR-2337). */
const AGENT_LABEL: Partial<Record<Change['field'], string>> = {
  runtime: 'Agent’s runtime',
  model: 'Agent’s model',
  effort: 'Agent’s effort',
};

/** One value of one part, in words. */
function formatValue(field: Change['field'], value: Change['from']): string {
  if (field === 'sticky') return value === true ? 'yes' : 'no';
  // In words, like the card's own cadence line; the timezone has its own line.
  if (field === 'cron') return formatCadence(typeof value === 'string' ? value : null, null);
  if (field === 'maxRuntime')
    return typeof value === 'number' ? formatDuration(value) : 'the default';
  if (value === null || value === '') {
    // A null runtime, model or effort follows the agent.
    return 'the agent’s own';
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
    change.via === 'agent'
      ? {
          // The agent's own value, changed outside DorkOS: unset on the agent
          // is the runtime's default, not "the agent's own".
          label: AGENT_LABEL[change.field] ?? LABEL[change.field],
          from: change.from === null ? 'the default' : String(change.from),
          to: change.to === null ? 'the default' : String(change.to),
          unbroken: true,
        }
      : change.field === 'prompt'
        ? { label: LABEL.prompt, from: null, to: 'changed (see below)', unbroken: false }
        : {
            label: LABEL[change.field],
            from: formatValue(change.field, change.from),
            to: formatValue(change.field, change.to),
            unbroken: change.field !== 'cron',
          }
  );
}
