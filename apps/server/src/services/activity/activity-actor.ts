/**
 * Who did this, as the Activity feed names them — one answer, read from one
 * request, so no surface has to invent its own.
 *
 * The feed already models three of the four actors it can meet: the person
 * (`user`), a named agent (`agent`, carrying the agent's path as `actorId`), and
 * DorkOS itself or a caller it cannot name (`system`). What was missing was a
 * single reader that turned an incoming HTTP request into one of them, so routes
 * hardcoded the answer instead. The extensions routes hardcoded
 * `user` / `'You'` on every write, which meant an agent setting an extension's
 * secret or setting appeared in the feed as something the person did themselves
 * (DOR-1801). A feed that names the wrong actor is worse than one that says
 * nothing, because it is believed.
 *
 * ## The three answers
 *
 * | The caller                                | What the feed says                    |
 * | ----------------------------------------- | ------------------------------------- |
 * | No `X-DorkOS-Agent` header                | `user` / `You`                        |
 * | Header present and resolved               | `agent` / the agent's name + path     |
 * | Header present and NOT resolved           | `system` / `Unidentified caller`      |
 *
 * The middle row uses the same label formula and the same `actorId` the agent
 * surfaces already used (`capability-attribution.ts`, `capability-gate-audit.ts`,
 * both of which now call in here rather than keeping their own copy).
 *
 * ## Why an unresolved header is not `You`
 *
 * A token that resolves to nothing still says a machine is calling — a person in
 * the app never sends the header at all, and the CLI attaches it only when
 * `DORKOS_AGENT_TOKEN` holds something (see {@link presentsAgentIdentity}, which
 * is the same distinction `lib/caller-authority.ts` and `routes/room-caller.ts`
 * make). Falling back to `You` there would be the exact lie this module exists to
 * stop, just in a rarer case.
 *
 * It is recorded as `system` / `Unidentified caller` rather than as a nameless
 * agent, matching what the capability surfaces have always done for the same
 * situation: **the feed must not imply DorkOS knows who acted when it does not.**
 * The presented token is never used as the label or the id — it is a credential,
 * and `middleware/agent-identity.ts` is careful never to log one; writing it into
 * an append-only feed the app renders would be worse.
 *
 * @module services/activity/activity-actor
 */
import path from 'node:path';
import type { Request, Response } from 'express';
import type { ActorType } from '@dorkos/shared/activity-schemas';
import type { AgentIdentity } from '../core/agent-identity/agent-identity-service.js';
import { getRequestAgentIdentity, presentsAgentIdentity } from '../../middleware/agent-identity.js';

/** What the feed says about a caller DorkOS cannot name. */
const UNIDENTIFIED_ACTOR_LABEL = 'Unidentified caller';

/** What the feed calls the person whose machine this is. */
const OPERATOR_ACTOR_LABEL = 'You';

/** The actor fields of an Activity event, ready to spread into `emit()`. */
export interface ActivityActor {
  /** Which kind of actor the feed should render. */
  actorType: ActorType;
  /** The agent's stable id (its path), when there is one to name. */
  actorId?: string;
  /** The name the feed shows. */
  actorLabel: string;
}

/**
 * Name a resolved agent identity — or the absence of one — for the feed.
 *
 * @param identity - The agent this request resolved to, or `undefined` when
 *   DorkOS could not tell who asked.
 * @returns The actor fields to record.
 */
export function activityActorForIdentity(identity: AgentIdentity | undefined): ActivityActor {
  if (!identity) return { actorType: 'system', actorLabel: UNIDENTIFIED_ACTOR_LABEL };

  // The agent's directory name is the legible handle; the full path is the
  // stable id, and the feed links on ids, not labels.
  return {
    actorType: 'agent',
    actorId: identity.agentPath,
    actorLabel: identity.displayName || path.basename(identity.agentPath),
  };
}

/**
 * Read the actor an HTTP request should be recorded under.
 *
 * @param req - The incoming request, read for the raw agent header.
 * @param res - The response carrying whatever the identity middleware resolved.
 * @returns The actor fields to spread into an `ActivityService.emit()` call.
 */
export function readActivityActor(
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>
): ActivityActor {
  if (!presentsAgentIdentity(req, res)) {
    return { actorType: 'user', actorLabel: OPERATOR_ACTOR_LABEL };
  }
  return activityActorForIdentity(getRequestAgentIdentity(res));
}
