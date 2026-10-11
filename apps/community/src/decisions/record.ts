/**
 * Turn one rung of the ladder into its `decision.*` audit row, and a flagged rung into a report
 * with `source='check'` in the moderation queue. Neither one changes the message: the report is a
 * hint a moderator resolves like any other, and the row is the record of why.
 *
 * @module decisions/record
 */
import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { LadderOutcome, LadderStep } from '@dorkos/decisions';
import type { CommunityDecisionRecord } from '@dorkos/shared/community-wire';
import { checkLabel, findingOf, type Finding } from './findings.js';

/** A record's rung name in the audit `action`: `decision.rung0`, `decision.rung1`. */
export const decisionAction = (rung: number) => `decision.rung${rung}`;

/** Why a built-in rule fired, in a moderator's words. */
const RULE_NOTES: Readonly<Record<string, (n: number) => string>> = {
  rate: (n) => `Posted ${n} messages in one minute.`,
  repeat: (n) => `Posted these same words ${n} times today.`,
  links: (n) => `Has ${n} links.`,
};

/** The facts a fired rule is about, by rule, for its note. */
export interface RuleCounts {
  rate: number;
  repeat: number;
  links: number;
}

/**
 * Build the record for one step. Answers keep their value, confidence and failure, and a built-in
 * rule's own reason code; a model's free text is never kept, so a post cannot write into it.
 *
 * @param outcome - The ladder run the step belongs to.
 * @param step - The step.
 * @param check - The check's name (`rules`, `jev`, `openai`).
 * @param authSecret - Keys the input hash, so a hash cannot confirm a guess at erased words.
 */
export function buildRecord(
  outcome: LadderOutcome,
  step: LadderStep,
  check: string,
  authSecret: string
): CommunityDecisionRecord {
  const inputHash = createHmac('sha256', authSecret)
    .update(JSON.stringify(outcome.request))
    .digest('hex');
  const base = {
    v: 1 as const,
    useCase: outcome.request.useCase,
    rung: step.rung,
    check,
    modelId: step.modelId.slice(0, 200),
    policyVersion: outcome.request.policyVersion,
    inputHash,
  };
  if ('skipped' in step)
    return {
      ...base,
      answers: {},
      confidence: 0,
      latencyMs: 0,
      costMicroUsd: null,
      skipped: step.skipped,
      verdict: 'unsure',
    };
  const answers: CommunityDecisionRecord['answers'] = {};
  for (const id of Object.keys(outcome.request.questions)) {
    const answer = step.result.answers[id];
    if (!answer) {
      answers[id] = { value: null, confidence: 0, failure: 'invalid-answer' };
      continue;
    }
    const value =
      typeof answer.value === 'string' ? answer.value.slice(0, 16) : (answer.value ?? null);
    answers[id] = {
      value,
      confidence: answer.confidence,
      ...(answer.failure ? { failure: answer.failure } : {}),
      // Only the built-in rules' reasons are ours to keep.
      ...(step.rung === 0 && answer.reason ? { reason: answer.reason.slice(0, 32) } : {}),
    };
  }
  return {
    ...base,
    modelId: (step.result.modelId || step.modelId).slice(0, 200),
    answers,
    confidence: step.confidence,
    latencyMs: Math.max(0, step.result.latencyMs),
    costMicroUsd: step.result.costMicroUsd ?? null,
    verdict: findingOf(answers).verdict,
  };
}

/**
 * Write one record as a `decision.*` audit row about `entryId`. A rung-0 row is the claim: when
 * another replica already wrote one for this message, nothing is written and this returns false.
 */
export async function writeRecord(
  client: PoolClient,
  target: { communityId: string; entryId: string },
  record: CommunityDecisionRecord
): Promise<boolean> {
  const written = await client.query(
    `INSERT INTO audit_events(community_id,actor_kind,action,subject_id,next_state,decision)
     VALUES($1,'system',$2,$3,$4,$5::jsonb)
     ON CONFLICT (community_id,subject_id)
       WHERE action='decision.rung0' AND origin='native' DO NOTHING
     RETURNING id`,
    [
      target.communityId,
      decisionAction(record.rung),
      target.entryId,
      record.verdict,
      JSON.stringify(record),
    ]
  );
  return (written.rowCount ?? 0) > 0;
}

/** The moderator's note for a flagged record. Never quotes the message. */
export function noteFor(record: CommunityDecisionRecord, found: Finding, counts?: RuleCounts) {
  const reason = record.answers.spam?.reason;
  if (record.check === 'rules' && reason && Object.hasOwn(RULE_NOTES, reason) && counts)
    return `${RULE_NOTES[reason]!(counts[reason as keyof RuleCounts])} Nothing was hidden.`;
  const who = checkLabel(record.check, record.modelId);
  const sure = `${Math.round(found.confidence * 100)}% sure`;
  const what =
    found.finding === 'rule'
      ? `breaks rule ${found.rule}`
      : found.finding === 'promotion'
        ? 'is self-promotion'
        : 'is spam';
  return `${who} thinks this ${what} (${sure}). Nothing was hidden.`;
}

/**
 * File a flagged record as a report in the queue, once per message and check, and only while
 * the message is still up. The report is the hint: a moderator acts on it or dismisses it.
 */
export async function fileCheckReport(
  client: PoolClient,
  target: { communityId: string; entryId: string },
  record: CommunityDecisionRecord,
  counts?: RuleCounts
): Promise<void> {
  const found = findingOf(record.answers);
  if (found.verdict !== 'flagged') return;
  const report = await client.query<{ id: string }>(
    `INSERT INTO reports(community_id,entry_id,source,check_name,reason,note)
     SELECT $1,$2,'check',$3,$4,$5 FROM entries e
     WHERE e.id=$2 AND e.community_id=$1 AND e.removed_at IS NULL AND e.erased_at IS NULL
     ON CONFLICT (entry_id,check_name) WHERE source='check' DO NOTHING
     RETURNING id`,
    [
      target.communityId,
      target.entryId,
      record.check,
      found.finding === 'rule' ? 'other' : 'spam',
      noteFor(record, found, counts).slice(0, 1000),
    ]
  );
  if (report.rows[0])
    await client.query(
      `INSERT INTO audit_events(community_id,actor_kind,action,subject_id)
       VALUES($1,'system','report.create',$2)`,
      [target.communityId, report.rows[0].id]
    );
}
