/**
 * What an agent reads when DorkOS refuses to set a scheduled task's mode or to
 * approve one for it (DOR-3703). Written for the model: each says what did not
 * happen, why, and what to do instead, because a model told only "no" tries
 * again. None names another tool by its id.
 *
 * @module services/tasks/agent-mode/agent-mode-copy
 */

/** The `error` line every refusal here carries. */
export const AGENT_MODE_REFUSAL_ERROR = 'DorkOS changed nothing on this scheduled task';

/** A task made by an agent that names its own status: it cannot approve itself. */
export const CREATE_WITH_STATUS_MESSAGE =
  'A new scheduled task cannot approve itself. Leave out the status: DorkOS decides whether ' +
  'it runs at once or waits, and someone other than you approves a task that waits.';

/** A status other than `active`, or a task that is not waiting. */
export const NOT_AN_APPROVAL_MESSAGE =
  'The only status you can send is "active", and only to approve a task that is waiting at ' +
  'pending_approval. To turn a task on or off, use `enabled` instead.';

/** An approval sent together with other changes. */
export const APPROVE_ALONE_MESSAGE =
  'Approve a task on its own: send the id, status "active" and, if you want, permissionMode. ' +
  'Send any other change separately. A task you change is one you can no longer approve.';

/** A mode a person must approve, sent with other changes the card would not show (M1). */
export const MODE_ALONE_MESSAGE =
  'A person has to approve this mode, and their card shows the task as it is now. Send the ' +
  'other changes in one call first, then the id and permissionMode alone in another.';

/** The agent made the task, changed it last, or shares a chat chain with whoever did. */
export const SELF_APPROVAL_MESSAGE =
  'You made or last changed this task, or a chat in your chain did, so you cannot approve it. ' +
  'The person approves it in DorkOS. Tell them it is waiting on them.';

/** DorkOS has no record of who last changed the task. */
export const UNKNOWN_EDITOR_MESSAGE =
  'DorkOS has no record of who last changed this task, so no agent can approve it. ' +
  'Tell the person it is waiting on them.';

/** A value that is not one of the permission modes. */
export const UNKNOWN_MODE_MESSAGE =
  'That is not a permission mode DorkOS knows for this task, so nothing was changed. Use one ' +
  'of: default, plan, dontAsk, acceptEdits, auto, bypassPermissions.';

/**
 * A mode above the lower of the caller's level and the task's agent's level.
 *
 * @param highest - The loosest mode that fits under that level.
 */
export function aboveCeilingMessage(highest: string): string {
  return (
    `That mode is above what you, or the agent this task runs as, may use. The highest you can ` +
    `set here is ${highest}. Send that or lower, or ask the person to choose a higher one.`
  );
}

/** The refusal code of a scheduled run's raise, which also tells the person (MUST-H). */
export const SCHEDULED_RAISE_CODE = 'scheduled_raise';

/** A scheduled run, a heartbeat, or a chat either one started, asked for a looser mode. */
export const SCHEDULED_RAISE_MESSAGE =
  'A scheduled run or a heartbeat, or a chat one of them started, cannot raise how a task runs. ' +
  'The task keeps running as it was, and the person has been told you asked. You can change its ' +
  'timing or lower its mode. Send any other change without permissionMode.';

/** A call that needs a person's approval and reached DorkOS without one. */
export const NEEDS_A_PERSON_MESSAGE =
  'This needs a person to approve it first, and no approval came with this call. Send the same ' +
  'call again and DorkOS will ask them.';

/** The person declined this task: approving it again is theirs to decide. */
export const DECLINED_MESSAGE =
  'The person declined this task, so no agent can approve it. If it should run, tell them ' +
  'and let them decide in DorkOS.';

/**
 * DorkOS cannot read the chat chain between the caller and whoever made or last
 * changed the task (one of them names no chat), so it cannot rule out that the
 * caller is approving its own work.
 */
export const LINEAGE_UNKNOWN_MESSAGE =
  'DorkOS cannot tell whether this task is your own work, so you cannot approve it. Ask from ' +
  'your own chat, or tell the person it is waiting on them.';

/**
 * The approval a person gave covered a version of the task that has changed
 * since (Security ruling 7, the card's binding).
 */
export const CONTENT_CHANGED_MESSAGE =
  'The task changed after the person was asked, so their answer does not cover it. Nothing ' +
  'was changed. Send the call again and DorkOS will ask them about the task as it is now.';
