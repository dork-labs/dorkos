/**
 * How a check's answers read as a verdict, shared by the worker that records them and the queue
 * that shows them. Plain data, no network and no decision bridges, so the HTTP app can import it
 * without loading `@dorkos/decisions`.
 *
 * The questions use neutral label codes (research `20261006_decision-models.md` §5e): models of
 * Jev's kind follow an option's name more than its description, so a label named `spam` would
 * leak the answer into the question.
 *
 * @module decisions/findings
 */
import type {
  CommunityDecisionRecord,
  CommunityWireReportCheck,
} from '@dorkos/shared/community-wire';

/** The use case every check on a new post records. */
export const POST_USE_CASE = 'community.post';

/** Question ids. `conduct` is asked only when the space has rules. */
export const SPAM_QUESTION = 'spam';
export const CONDUCT_QUESTION = 'conduct';

/** The spam question's labels: neutral codes, plain descriptions. */
export const SPAM_LABELS: Readonly<Record<string, string>> = {
  a1: 'An ordinary message: a question, an answer, an opinion, news, or a link shared to help.',
  a2: 'Spam: an advert, a scam, a link drop, or the same message posted again and again.',
  a3: "Self-promotion: there mostly to sell or promote the author's own product, service or channel.",
};

/** The spam labels that flag a message, and what each one found. */
const SPAM_FINDINGS: Readonly<Record<string, 'spam' | 'promotion'>> = {
  a2: 'spam',
  a3: 'promotion',
};

/** The conduct label for "breaks none of the rules"; rule n is `r<n>`. */
export const NO_RULE = 'r0';

/**
 * At or above this confidence an answer counts: a lean toward spam or a rule flags the message,
 * and a lean toward "fine" clears it. Below it the check is unsure. Watch-only either way:
 * nothing is hidden, whatever the confidence.
 */
export const FLAG_AT = 0.7;

/** One answer as a record keeps it. */
type RecordAnswer = CommunityDecisionRecord['answers'][string];

/** What a rung's answers say about the message. */
export interface Finding {
  verdict: CommunityDecisionRecord['verdict'];
  finding: CommunityWireReportCheck['finding'];
  rule: number | null;
  /** The confidence of the answer the finding rests on (the least confident when fine or unsure). */
  confidence: number;
}

/**
 * Read a rung's answers. Spam is read first: a message that is both spam and against a rule is
 * flagged as spam, the more common and less contested finding.
 *
 * @param answers - The rung's answers by question id. A question nobody asked is absent.
 */
export function findingOf(answers: Readonly<Record<string, RecordAnswer>>): Finding {
  const spam = answers[SPAM_QUESTION];
  if (spam && spam.confidence >= FLAG_AT && typeof spam.value === 'string') {
    const found = Object.hasOwn(SPAM_FINDINGS, spam.value) ? SPAM_FINDINGS[spam.value] : undefined;
    if (found)
      return { verdict: 'flagged', finding: found, rule: null, confidence: spam.confidence };
  }
  const conduct = answers[CONDUCT_QUESTION];
  if (conduct && conduct.confidence >= FLAG_AT && typeof conduct.value === 'string') {
    const rule = /^r([1-9][0-9]?)$/.exec(conduct.value);
    if (rule)
      return {
        verdict: 'flagged',
        finding: 'rule',
        rule: Number(rule[1]),
        confidence: conduct.confidence,
      };
  }
  const asked = Object.values(answers);
  const least = asked.length === 0 ? 0 : Math.min(...asked.map((a) => a.confidence));
  return {
    verdict: asked.length > 0 && least >= FLAG_AT ? 'fine' : 'unsure',
    finding: null,
    rule: null,
    confidence: least,
  };
}

/** How a check names itself on screen. */
export function checkLabel(check: string, modelId: string): string {
  if (check === 'rules') return 'Built-in rules';
  if (check === 'jev') return 'Jev';
  return modelId;
}
