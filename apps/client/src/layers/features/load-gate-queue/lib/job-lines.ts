/**
 * The words for one waiting heavy job (DOR-4209): who it is for, how long it
 * has waited, its buttons' names for a screen reader, and what an action came to.
 *
 * @module features/load-gate-queue/lib/job-lines
 */
import type { LoadGateJobAction, LoadGateWaitingJob } from '@dorkos/shared/load-gate-queue';
import { bucketElapsedMs } from '@/layers/shared/lib';

/** The letter each unit is spelled with. */
const SUFFIX = { minute: 'm', hour: 'h', day: 'd' } as const;

/**
 * Who the job is for, as the row's headline names it.
 *
 * @param job - The waiting job.
 */
export function jobOwner(job: LoadGateWaitingJob): string {
  if (!job.ownedHere) return 'Another app on this computer';
  return job.agentName ?? 'Your agent';
}

/**
 * The job as a phrase inside a sentence: "Scout’s pnpm", "another app’s tsc".
 *
 * @param job - The waiting job.
 */
export function jobPhrase(job: LoadGateWaitingJob): string {
  if (!job.ownedHere) return `another app’s ${job.label}`;
  return `${job.agentName ?? 'your agent'}’s ${job.label}`;
}

/**
 * How long it has waited: "Waiting" under a minute, then "Waiting 5m", "Waiting 2h".
 *
 * @param job - The waiting job.
 * @param now - The time now, in epoch milliseconds.
 */
export function waitedLine(job: LoadGateWaitingJob, now: number): string {
  const { value, unit } = bucketElapsedMs(now - job.waitingSinceMs);
  return value === 0 ? 'Waiting' : `Waiting ${value}${SUFFIX[unit]}`;
}

/**
 * Where the job stands, when a person has moved it: shown beside the wait.
 *
 * @param job - The waiting job.
 * @returns A short state word, or `null` for a job nobody moved.
 */
export function standingLine(job: LoadGateWaitingJob): string | null {
  if (job.letThrough) return 'Starting';
  if (job.front) return 'First in line';
  if (job.urgent) return 'Urgent';
  return null;
}

/**
 * Each button's name for a screen reader, naming the job it acts on.
 *
 * @param job - The waiting job.
 */
export function actionLabels(job: LoadGateWaitingJob): Record<LoadGateJobAction, string> {
  const phrase = jobPhrase(job);
  return {
    'let-through': `Let through ${phrase}`,
    urgent: `Mark ${phrase} urgent`,
    front: `Move to front: ${phrase}`,
  };
}

/**
 * Why a button can't be pressed for this job, or `undefined` when it can.
 *
 * @param job - The waiting job.
 * @param action - The button's action.
 */
export function disabledReason(
  job: LoadGateWaitingJob,
  action: LoadGateJobAction
): string | undefined {
  if (job.letThrough) return 'Starting now';
  if (action === 'front' && job.front) return 'Already first in line';
  if (action === 'urgent' && job.front) return 'Already first in line';
  if (action === 'urgent' && job.urgent) return 'Already urgent';
  return undefined;
}

/**
 * What a screen reader hears once an action took.
 *
 * @param job - The job it acted on.
 * @param action - What was done.
 */
export function doneAnnouncement(job: LoadGateWaitingJob, action: LoadGateJobAction): string {
  const phrase = jobPhrase(job);
  const subject = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  if (action === 'let-through') return `${subject} starts now.`;
  if (action === 'urgent') return `${subject} is urgent.`;
  return `${subject} is first in line.`;
}

/**
 * What a row says when an action did not take.
 *
 * @param error - What the action threw.
 */
export function actionError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 404) return 'This job isn’t waiting anymore.';
  return 'Couldn’t change this job. Try again.';
}
