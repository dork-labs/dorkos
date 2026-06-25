import { describe, it, expect } from 'vitest';
import { CommentsSchema } from '../config-schema.js';
import {
  shouldRespondToComment,
  type CommentDecisionContext,
  type CommentIdentity,
  type CommentsConfig,
  type InboxComment,
} from '../comment-response.js';
import type { OwnershipClass, WorkItem } from '../work-item.js';

/** The §9 resolved default comments config — `respondWhen: addressed`, `ambiguousBias: quiet`. */
const DEFAULT_COMMENTS: CommentsConfig = CommentsSchema.parse({});

/** The resolved agent identity used across the suite. */
const IDENTITY: CommentIdentity = { agent: 'agent-account', marker: '— 🤖 /flow' };

/** Build a WorkItem with overridable fields (mirrors dispatch.test's factory). */
function makeItem(overrides: Partial<WorkItem> & { identifier: string }): WorkItem {
  return {
    id: `node_${overrides.identifier}`,
    title: `Title ${overrides.identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'started',
    stateName: 'In Progress',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: [],
    ...overrides,
  };
}

/** Build an inbound comment with overridable fields. */
function comment(overrides: Partial<InboxComment> = {}): InboxComment {
  return { author: 'human-account', mentions: [], body: 'a plain comment', ...overrides };
}

/** Assemble the decision context: item + injected ownership + identity. */
function ctx(
  ownership: OwnershipClass,
  item: WorkItem = makeItem({ identifier: 'DOR-1' })
): CommentDecisionContext {
  return { item, ownership, identity: IDENTITY };
}

describe('shouldRespondToComment — rule 1: never answer its own comments', () => {
  it('ignores a comment authored by the agent account', () => {
    const c = comment({ author: 'agent-account', body: 'I claimed this' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });

  it('ignores a comment carrying the identity.marker (shared-account mode)', () => {
    // Different author, but the marker proves the agent wrote it.
    const c = comment({ author: 'shared-account', body: 'Assumption logged — 🤖 /flow' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });

  it('rule 1 wins even when the agent @mentions itself (no self-reply loop)', () => {
    // Own comment AND a self-@mention: rule 1 must outrank rule 2.
    const c = comment({
      author: 'agent-account',
      mentions: ['agent-account'],
      body: '/flow status',
    });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });
});

describe('shouldRespondToComment — rule 2: always respond when directly addressed', () => {
  it('responds on an @mention of the agent account', () => {
    const c = comment({ mentions: ['agent-account'], body: 'can you take this?' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });

  it('responds on an explicit /flow token in the body (shared-mode address)', () => {
    const c = comment({ body: '/flow please re-run verify' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });

  it('OVERRIDES ownership — responds even on an other-owned thread when mentioned', () => {
    const c = comment({ mentions: ['agent-account'], body: 'thoughts here?' });
    const decision = shouldRespondToComment(c, ctx('other'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });
});

describe('shouldRespondToComment — rule 3: resume a parked needs-input item', () => {
  it('resumes when an agent/needs-input item gets a non-agent comment', () => {
    const item = makeItem({ identifier: 'DOR-2', labels: ['agent/needs-input', 'stage/execute'] });
    const c = comment({ author: 'human-account', body: 'go with option B' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'resume', rule: 3 });
  });

  it("does NOT resume on the agent's own comment on a needs-input item (rule 1 wins)", () => {
    const item = makeItem({ identifier: 'DOR-2', labels: ['agent/needs-input'] });
    const c = comment({ author: 'agent-account', body: 'parked: which approach?' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });

  it('a directly-addressed comment on a needs-input item responds (rule 2 outranks rule 3)', () => {
    const item = makeItem({ identifier: 'DOR-2', labels: ['agent/needs-input'] });
    const c = comment({ mentions: ['agent-account'], body: 'here is the answer' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });
});

describe('shouldRespondToComment — rule 4: stay out of other-owned threads', () => {
  it('ignores a non-addressed comment on an other-owned thread', () => {
    const c = comment({ author: 'teammate', body: 'discussing internals' });
    const decision = shouldRespondToComment(c, ctx('other'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 4 });
  });
});

describe('shouldRespondToComment — rule 5: soft zone leans quiet', () => {
  it('ignores an ambiguous comment on a mine thread (quiet default)', () => {
    const c = comment({ author: 'human-account', body: 'nice progress' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 5 });
  });

  it('ignores an ambiguous comment on an unassigned thread (quiet default)', () => {
    const c = comment({ author: 'human-account', body: 'looks good' });
    const decision = shouldRespondToComment(c, ctx('unassigned'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 5 });
  });

  it('responds in the soft zone when ambiguousBias is flipped to engage', () => {
    const engage = CommentsSchema.parse({ ambiguousBias: 'engage' });
    const c = comment({ author: 'human-account', body: 'any update?' });
    const decision = shouldRespondToComment(c, ctx('reviewer'), engage);
    expect(decision).toEqual({ action: 'respond', rule: 5 });
  });
});
