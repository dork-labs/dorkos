/**
 * Who may write each field of a to-do, and who may make each kind of change (DOR-3088, Security's
 * Must 6). Enforced from the stored row, on the server, never from what a caller sends.
 *
 * "The person" always means a PROVEN person (`personProof`). A request that only passed this
 * computer's open gate (any program here could have sent it) may make a to-do, at the stranger
 * bound, and may do one more thing: finish, reopen, note or reorder a to-do assigned to the person.
 * An install with no owner account has no way to prove the person, and a to-do assigned to the
 * person never starts an agent turn (Security, #3460). It never reassigns, retitles or redates
 * anything, and every change it makes lowers the row to the stranger bound.
 *
 * @module services/commitments/todo-policy
 */
import type { CommitmentRow } from '@dorkos/db';
import type { TodoActor } from './commitment-authority.js';

/**
 * Who may write a field:
 *
 * - `server`: DorkOS sets it from its own records. No caller, person or agent, can send it.
 * - `once`: set when the to-do is made, from what the creator chose, and never changed.
 * - `editor`: the person, the assignee, or the agent that made it (`mayEdit`).
 * - `assignee`: the person, or the agent it is assigned to (`mayChangeState`, `mayRank`).
 * - `creator`: the person, or the agent that made it (`mayReassign`).
 */
export type FieldWriter = 'server' | 'once' | 'editor' | 'assignee' | 'creator';

/** A write-policy verdict for every column. A new column without one fails its test. */
export const TODO_FIELD_POLICY: Record<keyof CommitmentRow, FieldWriter> = {
  id: 'server',
  createdAt: 'server',
  assignedByKind: 'server',
  assignedBy: 'server',
  authority: 'server',
  authorityMarks: 'server',
  originMarks: 'server',
  chainDepth: 'server',
  chainAgents: 'server',
  titleFromSource: 'server',
  sourceAuthor: 'server',
  sourceSessionId: 'server',
  dueNotifiedAt: 'server',
  closedAt: 'server',
  sourceRoomEntryId: 'once',
  roomId: 'once',
  toAccount: 'once',
  what: 'editor',
  notes: 'editor',
  dueAt: 'editor',
  agentId: 'creator',
  ownerAccount: 'creator',
  state: 'assignee',
  note: 'assignee',
  rank: 'assignee',
};

/** The agent a to-do is assigned to, or undefined when a person owns it. */
function assigneeAgent(row: Pick<CommitmentRow, 'agentId'>): string | null {
  return row.agentId;
}

/** Whether an agent made this to-do. */
function madeBy(row: Pick<CommitmentRow, 'assignedByKind' | 'assignedBy'>, agentId: string) {
  return row.assignedByKind === 'agent' && row.assignedBy === agentId;
}

/**
 * Whether an actor may change a to-do's state or how it ended: the person, or the agent it is
 * assigned to. An unproven person may, on a to-do assigned to the person only.
 *
 * @param row - The stored row.
 * @param actor - Who is asking.
 */
export function mayChangeState(row: CommitmentRow, actor: TodoActor): boolean {
  if (actor.kind === 'person') return actor.proven || assigneeAgent(row) === null;
  return actor.kind === 'agent' && assigneeAgent(row) === actor.agentId;
}

/**
 * Whether an actor may reassign a to-do: the person, or the agent that made it.
 *
 * @param row - The stored row.
 * @param actor - Who is asking.
 */
export function mayReassign(row: CommitmentRow, actor: TodoActor): boolean {
  if (actor.kind === 'person') return actor.proven;
  return actor.kind === 'agent' && madeBy(row, actor.agentId);
}

/**
 * Whether an actor may edit a to-do's title, notes or due date: the person, the assignee, the
 * agent that made it, or an outsider who made it. An outsider's edit lowers the to-do to the
 * stranger bound (Must 3).
 *
 * @param row - The stored row.
 * @param actor - Who is asking.
 */
export function mayEdit(row: CommitmentRow, actor: TodoActor): boolean {
  if (actor.kind === 'person') return actor.proven;
  if (actor.kind === 'outsider') {
    return row.assignedByKind === 'outsider' && row.assignedBy === actor.id;
  }
  return assigneeAgent(row) === actor.agentId || madeBy(row, actor.agentId);
}

/**
 * Whether an actor may move a to-do in its owner's order: the person, or the agent that owns it,
 * with the same reach for an unproven person as {@link mayChangeState}.
 *
 * @param row - The stored row.
 * @param actor - Who is asking.
 */
export function mayRank(row: CommitmentRow, actor: TodoActor): boolean {
  return mayChangeState(row, actor);
}
