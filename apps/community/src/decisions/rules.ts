/**
 * Rung 0 of the post checks: free, offline rules over facts the database already knows — how
 * fast the author is posting, how many links the message has, and how often they posted the same
 * words today (research `20261006_decision-models.md` §5b, bridge 1).
 *
 * A rule either fires (spam, confidence 1) or abstains; it never says a message is fine, so a
 * message no rule flags goes on to the decision models.
 *
 * @module decisions/rules
 */
import type { PoolClient } from 'pg';
import { createRulesModel } from '@dorkos/decisions';
import type { DecisionModel } from '@dorkos/shared/decision-model';
import { SPAM_QUESTION } from './findings.js';

/** What the rules read about one message. Counts only: no other message's words. */
export interface PostFacts {
  /** Messages by the same person (with their agents) in the minute up to this one, itself included. */
  postsLastMinute: number;
  /** Links in this message. */
  links: number;
  /** Messages by the same person in the last day with these exact words, this one included. */
  sameTextToday: number;
}

/** Where each rule fires. */
export const RULE_LIMITS = {
  postsPerMinute: 10,
  links: 5,
  sameTextToday: 3,
  /** A short message ("thanks!", "+1") is repeated honestly; repeats count from this length. */
  repeatMinLength: 12,
} as const;

/** Count the links in a message: anything that starts like a web address. */
export function countLinks(text: string): number {
  return text.match(/\bhttps?:\/\/|\bwww\./gi)?.length ?? 0;
}

/** The one message the facts are about. */
export interface FactsSubject {
  id: string;
  communityId: string;
  /** The person the message counts as: its author, or an agent's owner. */
  ownerMemberId: string;
  text: string;
}

/**
 * Read the facts for one message. Both counts use the `(community_id, created_at)` index and
 * stop at the message's own time, so a later flood does not change an earlier message's facts.
 */
export async function readPostFacts(client: PoolClient, entry: FactsSubject): Promise<PostFacts> {
  // The message's own time is read in SQL: a JavaScript Date keeps milliseconds, the column
  // microseconds, so a round trip would leave the message out of its own counts.
  const result = await client.query<{ last_minute: number; same_text: number }>(
    `WITH self AS (SELECT created_at FROM entries WHERE id=$3 AND community_id=$1)
     SELECT
       count(*) FILTER (WHERE e.created_at > self.created_at - interval '1 minute')::int
         AS last_minute,
       count(*) FILTER (WHERE char_length($4::text) >= $5
         AND lower(btrim(e.text)) = lower(btrim($4::text)))::int AS same_text
     FROM self, entries e LEFT JOIN agents a ON a.id=e.author_agent_id
     WHERE e.community_id=$1 AND (e.author_member_id=$2 OR a.owner_member_id=$2)
       AND e.created_at > self.created_at - interval '1 day' AND e.created_at <= self.created_at`,
    [entry.communityId, entry.ownerMemberId, entry.id, entry.text, RULE_LIMITS.repeatMinLength]
  );
  const row = result.rows[0];
  return {
    postsLastMinute: row?.last_minute ?? 1,
    links: countLinks(entry.text),
    sameTextToday: row?.same_text ?? 1,
  };
}

/** Narrow a request's context back to the facts the worker put there. */
function factsOf(context: unknown): PostFacts | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const facts = (context as { facts?: unknown }).facts;
  if (typeof facts !== 'object' || facts === null) return undefined;
  const { postsLastMinute, links, sameTextToday } = facts as Record<string, unknown>;
  return typeof postsLastMinute === 'number' &&
    typeof links === 'number' &&
    typeof sameTextToday === 'number'
    ? { postsLastMinute, links, sameTextToday }
    : undefined;
}

/**
 * The rules bridge for posts. It answers the spam question with `a2` (spam) when a rule fires,
 * naming the rule in `reason`, and abstains otherwise.
 */
export function createPostRules(): DecisionModel {
  return createRulesModel({
    id: 'rules',
    checks: {
      [SPAM_QUESTION]: (req) => {
        const facts = factsOf(req.context);
        if (!facts) return undefined;
        if (facts.postsLastMinute >= RULE_LIMITS.postsPerMinute)
          return { value: 'a2', reason: 'rate' };
        if (facts.sameTextToday >= RULE_LIMITS.sameTextToday)
          return { value: 'a2', reason: 'repeat' };
        if (facts.links >= RULE_LIMITS.links) return { value: 'a2', reason: 'links' };
        return undefined;
      },
    },
  });
}
