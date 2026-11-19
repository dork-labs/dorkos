/**
 * The waiting line as the person sees it (DOR-4209): the gate's own list turned
 * into the wire shape `GET /api/system/load-gate/waiting` answers with.
 *
 * What may reach the screen, and from where:
 *
 * - **Who a job is for** (agent, chat) comes only from this server's memory. A
 *   ticket this server did not queue was queued by another DorkOS app on this
 *   computer, and says so (`ownedHere: false`), with no name at all.
 * - **What it runs** is a program name and nothing else. For a job this server
 *   queued it is the label this server kept. For another app's job it is the
 *   ticket file's label, which the queue already refused unless it is one plain
 *   word (`JOB_LABEL`), cut short and stripped again here.
 * - **Nothing else** in the shared folder (marks, markers, other fields) ever
 *   becomes text.
 *
 * @module services/core/load-gate/person-view
 */
import type { LoadGateWaitingJob, LoadGateWaitingLine } from '@dorkos/shared/load-gate-queue';
import type { WaitingJob } from './load-gate.js';

/** The longest program name the list shows. */
const MAX_LABEL_CHARS = 40;
/** The longest agent or chat name the list shows; the app cuts it shorter to fit. */
const MAX_NAME_CHARS = 120;
/** What a job is called when its label has nothing left to show. */
const UNNAMED_JOB = 'job';
/** Control and format characters: never shown, so a name cannot reorder or hide text. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}]/gu;

/** `text` with nothing unshowable in it, trimmed and cut to `max` characters. */
function showable(text: string, max: number): string {
  return Array.from(text.replace(UNSHOWABLE, '').trim()).slice(0, max).join('');
}

/**
 * The program name to show for a job.
 *
 * @param job - The job's label, from this server's memory or the ticket.
 */
export function jobLabelForPerson(job: string): string {
  return showable(job, MAX_LABEL_CHARS) || UNNAMED_JOB;
}

/** A name from this server's memory, when it has something to show. */
function name(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return showable(text, MAX_NAME_CHARS) || undefined;
}

/**
 * When a job started waiting: its ticket's time, never later than now, so a
 * ticket stamped in the future cannot show a negative wait.
 */
function waitingSince(createdAt: number, now: number): number {
  return Number.isFinite(createdAt) ? Math.min(createdAt, now) : now;
}

/**
 * The person's view of one waiting job.
 *
 * @param job - The gate's entry for it.
 * @param position - Its place in line, counting from 1.
 * @param now - The wall clock now.
 */
function viewOf(job: WaitingJob, position: number, now: number): LoadGateWaitingJob {
  const agentName = job.ownedHere ? name(job.agentName) : undefined;
  const chatTitle = job.ownedHere ? name(job.chatTitle) : undefined;
  return {
    id: job.id,
    position,
    ownedHere: job.ownedHere,
    ...(agentName === undefined ? {} : { agentName }),
    ...(chatTitle === undefined ? {} : { chatTitle }),
    label: jobLabelForPerson(job.job),
    waitingSinceMs: waitingSince(job.createdAt, now),
    urgent: job.priority === 'urgent',
    front: job.front === true,
    letThrough: job.letThrough === true,
  };
}

/**
 * The waiting line, in the order the gate lists it.
 *
 * @param jobs - The gate's list (`LoadGate.waitingJobs`).
 * @param now - The wall clock now.
 */
export function waitingLineForPerson(
  jobs: readonly WaitingJob[],
  now: number = Date.now()
): LoadGateWaitingLine {
  return { jobs: jobs.map((job, index) => viewOf(job, index + 1, now)) };
}
