/**
 * What in a space wakes the owner's agents:
 *
 * - who may wake them at all (spec `official-community-space` D9): `GET` and
 *   `PUT /api/community-connections/:ref/wake-agents-from`;
 * - where any person's post wakes them without a mention (D11): `GET` and
 *   `PUT /api/community-connections/:ref/answer-in`.
 *
 * Owner-only, like every connection route: the owner check it is handed
 * (`resolveCommunityOwner`) refuses an agent's identity,
 * a remote caller and anyone but this install's owner, and no DorkOS tool or config key reaches
 * the setting. (With login off, an agent's own shell on this machine is the local-trust
 * residual, and a stranger's turn asks before it runs one.) Letting members wake the agents,
 * or adding a channel they answer in, waits for the owner to confirm it's them (DOR-4355);
 * narrowing either stays immediate.
 *
 * @module routes/community-answer-in
 */
import type { Context, Hono } from 'hono';
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_ANSWER_IN_MAX,
  CommunityAnswerInSchema,
  CommunityWakeAgentsFromSchema,
} from '@dorkos/shared/community-connections';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { RemoteConnectionNotFoundError } from '../services/communities/remote/connection-store.js';
import type { RemoteWakePolicy } from '../services/communities/remote/wake/wake-policy.js';
import { AnswerInChangedError } from '../services/communities/remote/wake/answer-in-store.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** The part of the wake policy these routes read and write. */
export type AnswerInPolicy = Pick<RemoteWakePolicy, 'getAnswerIn' | 'setAnswerIn'>;

/** The part of the wake policy the wake-agents-from routes read and write. */
export type WakeAgentsFromPolicy = Pick<RemoteWakePolicy, 'get' | 'set'>;

/** The connection routes' owner check: the owner's id, or the refusal to answer with. */
type OwnerCheck = (c: Context<ApiEnv>) => string | Response;

/** What the hold's refusals name. */
const SUBJECT = 'who can wake your agents';

/** The owner and the connection a request names, or the answer to give instead. */
function ownerAndRef(
  c: Context<ApiEnv>,
  resolveCommunityOwner: OwnerCheck
): { owner: string; ref: CommunityRef } | Response {
  const owner = resolveCommunityOwner(c);
  if (typeof owner !== 'string') return owner;
  const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
  if (!ref.success) return notFound(c);
  return { owner, ref: ref.data };
}

/**
 * Add the wake-agents-from routes to the connection routes.
 *
 * @param router - The `/api/community-connections` routes.
 * @param resolveCommunityOwner - The connection routes' owner check.
 * @param policy - Looked up per request, so building the routes reads nothing from disk.
 * @param fail - The connection routes' answer for a failed read or write.
 */
export function addWakeAgentsFromRoutes(
  router: Hono<ApiEnv>,
  resolveCommunityOwner: OwnerCheck,
  policy: () => WakeAgentsFromPolicy,
  fail: (c: Context, error: unknown) => Response
): void {
  router.get('/:ref/wake-agents-from', async (c) => {
    const named = ownerAndRef(c, resolveCommunityOwner);
    if (named instanceof Response) return named;
    try {
      return c.json(
        CommunityWakeAgentsFromSchema.parse({
          wakeAgentsFrom: await policy().get(named.ref, named.owner),
        })
      );
    } catch (error) {
      return fail(c, error);
    }
  });
  router.put('/:ref/wake-agents-from', async (c) => {
    const named = ownerAndRef(c, resolveCommunityOwner);
    if (named instanceof Response) return named;
    const { owner, ref } = named;
    const body = CommunityWakeAgentsFromSchema.safeParse(readJsonBody(c));
    if (!body.success) {
      return c.json({ error: 'Choose who can wake your agents: me or members.' }, 400);
    }
    const next = body.data.wakeAgentsFrom;
    const run = async () => {
      try {
        await policy().set(ref, owner, next);
        return c.json(body.data);
      } catch (error) {
        return fail(c, error);
      }
    };
    if (next !== 'members') return run();
    try {
      if ((await policy().get(ref, owner)) === 'members') return run();
    } catch (error) {
      return fail(c, error);
    }
    return runFrontDoorWrite(c, {
      kind: 'community.wake',
      target: ref,
      input: { wakeAgentsFrom: next },
      reason: 'Let members of this space wake your agents.',
      subject: SUBJECT,
      run,
    });
  });
}

/**
 * Add the answer-in routes to the connection routes.
 *
 * @param router - The `/api/community-connections` routes.
 * @param resolveCommunityOwner - The connection routes' owner check: the owner's id, or the
 *   refusal to answer with.
 * @param policy - Looked up per request, so building the routes reads nothing from disk.
 */
export function addAnswerInRoutes(
  router: Hono<ApiEnv>,
  resolveCommunityOwner: OwnerCheck,
  policy: () => AnswerInPolicy
): void {
  router.get('/:ref/answer-in', async (c) => {
    const named = ownerAndRef(c, resolveCommunityOwner);
    if (named instanceof Response) return named;
    try {
      return c.json(
        CommunityAnswerInSchema.parse({
          answerIn: await policy().getAnswerIn(named.ref, named.owner),
        })
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  router.put('/:ref/answer-in', async (c) => {
    const named = ownerAndRef(c, resolveCommunityOwner);
    if (named instanceof Response) return named;
    const { owner, ref } = named;
    const body = CommunityAnswerInSchema.safeParse(readJsonBody(c));
    if (!body.success) {
      return c.json(
        { error: `List up to ${COMMUNITY_ANSWER_IN_MAX} channel names, like help or welcome.` },
        400
      );
    }
    const next = body.data.answerIn;
    /** Save it; a free save lands only if it still adds no channel when it writes. */
    const run = async (free: boolean) => {
      const addsNothing = (current: readonly string[]) =>
        next.every((name) => current.includes(name));
      try {
        await policy().setAnswerIn(ref, owner, next, free ? addsNothing : undefined);
        return c.json(body.data);
      } catch (error) {
        if (error instanceof AnswerInChangedError) {
          return c.json({ error: error.message, code: 'ANSWER_IN_CHANGED' }, 409);
        }
        return failure(c, error);
      }
    };
    let added: string[];
    try {
      const current = new Set(await policy().getAnswerIn(ref, owner));
      added = next.filter((name) => !current.has(name));
    } catch (error) {
      return failure(c, error);
    }
    if (added.length === 0) return run(true);
    return runFrontDoorWrite(c, {
      kind: 'community.wake',
      target: ref,
      input: { answerIn: next },
      reason:
        added.length === 1
          ? `Let any post in #${added[0]} wake your agents.`
          : `Let any post in ${added.length} more channels wake your agents.`,
      subject: SUBJECT,
      run: () => run(false),
    });
  });
}

function notFound(c: Context): Response {
  return c.json({ error: 'Space connection not found.' }, 404);
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof RemoteConnectionNotFoundError) return notFound(c);
  return c.json({ error: 'Could not save where your agents answer. Try again.' }, 500);
}
