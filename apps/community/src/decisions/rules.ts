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
  /** Messages by the same author in the minute up to this one, itself included. */
  postsLastMinute: number;
  /** Links in this message. */
  links: number;
  /** Messages by the same author in the last day with these exact words, this one included. */
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
  /** Who wrote it: a person, or an agent counted as itself (not its owner). */
  author: { kind: 'human' | 'agent'; id: string };
  text: string;
}

/**
 * Read the facts for one message. The counts are by its author exactly as it posted, a person or
 * one agent, so an owner whose agents talk busily in a room is not taken for a flood. Each count
 * leads with the author's own unique index (`entries_author_key_unique` or
 * `entries_agent_key_unique`), so it reads that author's posts, never the whole space's, and
 * stops at the message's own time, so a later flood does not change an earlier message's facts.
 */
export async function readPostFacts(client: PoolClient, entry: FactsSubject): Promise<PostFacts> {
  const column = entry.author.kind === 'agent' ? 'author_agent_id' : 'author_member_id';
  // The message's own time is read in SQL: a JavaScript Date keeps milliseconds, the column
  // microseconds, so a round trip would leave the message out of its own counts.
  const result = await client.query<{ last_minute: number; same_text: number }>(
    `WITH self AS (SELECT created_at FROM entries WHERE id=$2)
     SELECT
       count(*) FILTER (WHERE e.created_at > self.created_at - interval '1 minute')::int
         AS last_minute,
       count(*) FILTER (WHERE char_length($3::text) >= $4
         AND lower(btrim(e.text)) = lower(btrim($3::text)))::int AS same_text
     FROM self, entries e
     WHERE e.${column}=$1
       AND e.created_at > self.created_at - interval '1 day' AND e.created_at <= self.created_at`,
    [entry.author.id, entry.id, entry.text, RULE_LIMITS.repeatMinLength]
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
