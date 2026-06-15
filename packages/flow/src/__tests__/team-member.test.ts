/**
 * Agent-as-team-member integration suite (§5, §7; Phase 3 acceptance) — the
 * "comment-rule suite wired to the **real** ownership primitive". The unit
 * suites test {@link classifyOwnership} and {@link shouldRespondToComment} in
 * isolation (each injecting the other's input); this suite proves the two TS
 * pieces actually **compose** the way the agent-as-team-member loop composes
 * them: feed a `WorkItem` through the REAL {@link classifyOwnership}
 * (`identity.ts`, task 3.1) and inject its `OwnershipClass` output straight into
 * {@link shouldRespondToComment} (`comment-response.ts`), then walk the five
 * comment-response rules across the matrix.
 *
 * Imports from the relative module paths (`../identity.js`,
 * `../comment-response.js`) — NOT the `@dorkos/flow` barrel — matching the other
 * flow suites; the orchestrator wires barrel exports later.
 *
 * @see specs/unified-workflow-system/02-specification.md §5 (comment-response), §7 (ownership)
 * @see .agents/flow/skills/tending-tracker/SKILL.md (the prose loop these pieces back)
 */

import { describe, expect, it } from 'vitest';
import { CommentsSchema } from '../config-schema.js';
import {
  shouldRespondToComment,
  type CommentAction,
  type CommentDecisionContext,
  type InboxComment,
} from '../comment-response.js';
import { classifyOwnership, type Identity } from '../identity.js';
import type { WorkItem } from '../work-item.js';

/** Resolved agent account id used across the suite. */
const AGENT = 'acct-agent';
/** Distinct resolved reviewer account (two-account mode). */
const REVIEWER = 'acct-reviewer';
/** A teammate / other agent account → the `other` class. */
const TEAMMATE = 'acct-teammate';
/** The durable authorship marker the agent appends to its own writes. */
const MARKER = '— 🤖 /flow';

/** Two-account identity: agent and reviewer are distinct resolved accounts. */
const TWO_ACCOUNT: Identity = { agent: AGENT, reviewer: REVIEWER, marker: MARKER };
/** Shared-account identity: no distinct reviewer (`reviewer: null`). */
const SHARED: Identity = { agent: AGENT, reviewer: null, marker: MARKER };

/** The §9 default `comments` config — `respondWhen: addressed`, `ambiguousBias: quiet`. */
const DEFAULT_COMMENTS = CommentsSchema.parse({});
/** The chatty override — `ambiguousBias: engage` flips the soft zone to respond. */
const ENGAGE_COMMENTS = CommentsSchema.parse({ ambiguousBias: 'engage' });

/** Build a fully-formed WorkItem with overridable `assignee` / `labels`. */
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'node_DOR-1',
    identifier: 'DOR-1',
    title: 'Title',
    description: '',
    type: 'task',
    stateCategory: 'started',
    stateName: 'In Progress',
    priority: 3,
    size: 'md',
    project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: [],
    assignee: AGENT,
    agentDisposition: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build an inbox comment with overridable author / mentions / body. */
function makeComment(overrides: Partial<InboxComment> = {}): InboxComment {
  return { author: TEAMMATE, mentions: [], body: 'a plain comment', ...overrides };
}

/**
 * THE COMPOSITION SEAM. Run an item through the REAL {@link classifyOwnership}
 * and feed its output straight into {@link shouldRespondToComment} — exactly the
 * wiring the team-member loop performs each inbox tick. Returns the decided
 * action so the matrix asserts on respond/resume/ignore end to end.
 */
function decideOnComment(
  item: WorkItem,
  comment: InboxComment,
  identity: Identity,
  comments = DEFAULT_COMMENTS
): CommentAction {
  // The real ownership primitive (task 3.1) — not an injected literal.
  const ownership = classifyOwnership(item, identity);
  const ctx: CommentDecisionContext = {
    item,
    ownership,
    identity: { agent: identity.agent, marker: identity.marker },
  };
  return shouldRespondToComment(comment, ctx, comments).action;
}

describe('team-member loop — comment rules wired to the REAL classifyOwnership (§5 × §7)', () => {
  it('rule 1: ignores the agent’s OWN comment (author == agent), even on a mine-owned item', () => {
    // Item assigned to the agent → classifyOwnership returns `mine`; the comment
    // is authored by the agent account → rule 1 fires first, no self-reply loop.
    const item = makeItem({ assignee: AGENT });
    const own = makeComment({ author: AGENT, body: 'progress update' });
    expect(decideOnComment(item, own, TWO_ACCOUNT)).toBe('ignore');
  });

  it('rule 1: ignores its own comment by MARKER in shared mode (author indistinguishable)', () => {
    // Shared account: the human and agent share `acct-agent`, so author alone
    // cannot tell them apart — the marker in the body is the only signal.
    const item = makeItem({ assignee: AGENT });
    const markedByAgent = makeComment({ author: AGENT, body: `Picked this up. ${MARKER}` });
    expect(decideOnComment(item, markedByAgent, SHARED)).toBe('ignore');
  });

  it('rule 2: RESPONDS to an @mention on a teammate’s (other-owned) item — overrides ownership', () => {
    // Assigned to a teammate → classifyOwnership returns `other` (which alone
    // would mean rule 4 → ignore), but a direct @mention overrides ownership.
    const item = makeItem({ assignee: TEAMMATE });
    expect(classifyOwnership(item, TWO_ACCOUNT)).toBe('other');
    const mention = makeComment({ author: TEAMMATE, mentions: [AGENT], body: 'can you weigh in?' });
    expect(decideOnComment(item, mention, TWO_ACCOUNT)).toBe('respond');
  });

  it('rule 2: RESPONDS to an explicit /flow token in shared mode on an other-owned item', () => {
    // Shared mode has no distinct agent account to @mention, so an explicit
    // /flow token in the body is the addressing signal — still overrides `other`.
    const item = makeItem({ assignee: TEAMMATE });
    expect(classifyOwnership(item, SHARED)).toBe('other');
    const token = makeComment({ author: TEAMMATE, body: '/flow can you take this?' });
    expect(decideOnComment(item, token, SHARED)).toBe('respond');
  });

  it('rule 3: RESUMES a parked agent/needs-input item on a non-agent reply (the parked answer)', () => {
    // The agent parked on a question via needsInput (agent/needs-input label).
    // A human reply (non-agent author, no marker) IS the answer it parked for.
    const item = makeItem({ assignee: AGENT, labels: ['agent/needs-input'] });
    const humanReply = makeComment({ author: REVIEWER, body: 'go with option B' });
    expect(decideOnComment(item, humanReply, TWO_ACCOUNT)).toBe('resume');
  });

  it('rule 3 is gated by rule 1: the agent’s OWN comment on a needs-input item never resumes', () => {
    // Rule 1 precedence — the agent echoing the marker on its own parked item
    // must not be mistaken for the human’s answer (no self-resume loop).
    const item = makeItem({ assignee: AGENT, labels: ['agent/needs-input'] });
    const ownMarked = makeComment({ author: AGENT, body: `Still waiting. ${MARKER}` });
    expect(decideOnComment(item, ownMarked, SHARED)).toBe('ignore');
  });

  it('rule 4: IGNORES an other-owned thread with no mention (stay out of teammates’ threads)', () => {
    // Assigned to a teammate, no @mention, no /flow token, not parked → the real
    // `other` class drives rule 4 → ignore.
    const item = makeItem({ assignee: TEAMMATE });
    expect(classifyOwnership(item, TWO_ACCOUNT)).toBe('other');
    const chatter = makeComment({ author: TEAMMATE, body: 'looks good to me' });
    expect(decideOnComment(item, chatter, TWO_ACCOUNT)).toBe('ignore');
  });

  it('rule 5: AMBIGUOUS (mine-owned, not addressed, not parked) leans quiet by default', () => {
    // The agent’s own thread, a teammate chimes in with no address and no parked
    // question → the soft zone. With the default `quiet` bias → ignore.
    const item = makeItem({ assignee: AGENT });
    expect(classifyOwnership(item, TWO_ACCOUNT)).toBe('mine');
    const chatter = makeComment({ author: TEAMMATE, body: 'nice work' });
    expect(decideOnComment(item, chatter, TWO_ACCOUNT, DEFAULT_COMMENTS)).toBe('ignore');
  });

  it('rule 5: the SAME ambiguous case flips to respond under ambiguousBias: "engage"', () => {
    // Re-tuning chattiness is a config edit, never a code change — same item,
    // same comment, `engage` bias → respond.
    const item = makeItem({ assignee: AGENT });
    const chatter = makeComment({ author: TEAMMATE, body: 'nice work' });
    expect(decideOnComment(item, chatter, TWO_ACCOUNT, ENGAGE_COMMENTS)).toBe('respond');
  });

  it('rule 5: an unassigned item with a non-agent comment leans quiet (soft zone)', () => {
    // No assignee → classifyOwnership returns `unassigned` (not `other`), so it
    // falls through to the soft zone rather than rule 4.
    const item = makeItem({ assignee: undefined });
    expect(classifyOwnership(item, TWO_ACCOUNT)).toBe('unassigned');
    const chatter = makeComment({ author: TEAMMATE, body: 'who owns this?' });
    expect(decideOnComment(item, chatter, TWO_ACCOUNT)).toBe('ignore');
  });

  it('rule 5: a reviewer-owned item (two-account) with a non-agent comment leans quiet', () => {
    // Assigned to the distinct reviewer → `reviewer` class (NOT `other`), so it
    // is the soft zone, not rule 4 — quiet by default.
    const item = makeItem({ assignee: REVIEWER });
    expect(classifyOwnership(item, TWO_ACCOUNT)).toBe('reviewer');
    const chatter = makeComment({ author: REVIEWER, body: 'thoughts?' });
    expect(decideOnComment(item, chatter, TWO_ACCOUNT)).toBe('ignore');
  });

  it('precedence: a direct @mention beats rule 4 even when ownership is `other`', () => {
    // Belt-and-suspenders on the ordering: rule 2 (respond) must win over rule 4
    // (ignore) when both could apply — addressing always wins over staying out.
    const item = makeItem({ assignee: TEAMMATE });
    const mentioned = makeComment({ author: TEAMMATE, mentions: [AGENT], body: 'ping' });
    expect(decideOnComment(item, mentioned, TWO_ACCOUNT)).toBe('respond');
  });
});
