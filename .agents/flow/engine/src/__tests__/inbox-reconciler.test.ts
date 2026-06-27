/**
 * Unit suite for the **inbox / resume reconciler** (task 4.6) — the priority-20
 * reconciler wrapping {@link shouldRespondToComment} over the `comment.added`
 * events the tick polls from the injected `InboundTransport`.
 *
 * The invariants pinned here (§4, §5):
 *   - a non-agent reply on a parked `agent/needs-input` item → `resume`, and the
 *     action carries the FlowRun `sessionId` (the `--resume` handle);
 *   - an agent-authored (marker) reply → NO action (rule 1, no self-resume loop) —
 *     identity-mode-agnostic: the marker disambiguates in shared mode;
 *   - a non-needs-input item with a stray comment → no resume (rule 3 is gated on
 *     the parked label);
 *   - no local FlowRun → `resume` falls back to thread-replay;
 *   - ordering: inbox(20) sorts AFTER recovery(10) and BEFORE dispatch(30); a
 *     resumed item is claimed for the tick so dispatch stands down on it.
 *
 * The reconciler is pure: every event/item/ownership/run fact is injected via the
 * {@link InboxCandidate} bag (no transport I/O, no tracker). Imports from relative
 * module paths (NOT the `@dorkos/flow` barrel), matching the sibling suites.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §4, §5
 */

import { describe, expect, it } from 'vitest';
import { CommentsSchema, DispatchSchema, OwnershipSchema, WipCapSchema } from '../config-schema.js';
import type { CommentIdentity, CommentsConfig } from '../comment-response.js';
import type { CommentAddedEvent } from '../events.js';
import { trackerEventDedupeKey } from '../events.js';
import type { DispatchOptions } from '../dispatch.js';
import type { FlowRun } from '../flow-run.js';
import type { OwnershipClass, WorkItem } from '../work-item.js';
import type { ReconcileContext } from '../reconciler.js';
import { runTick } from '../scheduler.js';
import {
  defaultRegistry,
  inboxReconciler,
  type FlowReconcileInput,
  type InboxCandidate,
  type InboxReconcileInput,
} from '../reconcilers.js';

// ─── shared fixtures ─────────────────────────────────────────────────────────

/** Resolved agent account id. */
const AGENT = 'acct-agent';
/** Distinct reviewer account (two-account mode). */
const REVIEWER = 'acct-reviewer';
/** The durable authorship marker. */
const MARKER = '— 🤖 /flow';

/** The §9 default comments config (respondWhen addressed, ambiguousBias quiet). */
const DEFAULT_COMMENTS: CommentsConfig = CommentsSchema.parse({});
/** The resolved agent identity the rules compare against. */
const IDENTITY: CommentIdentity = { agent: AGENT, marker: MARKER };

/** A WorkItem with overridable assignee / labels (parked by default). */
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
    labels: ['agent/needs-input'],
    assignee: AGENT,
    agentDisposition: 'needs-input',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A durable run record (carries the sessionId resume handle). */
function flowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: 'node_DOR-1',
    identifier: 'DOR-1',
    sessionId: 'session-xyz',
    worktreePath: '/Users/x/.dork/workspaces/core/DOR-1',
    branch: 'dork/DOR-1',
    stage: 'execute',
    status: 'waiting_for_review',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-06-25T00:00:00.000Z',
    ...overrides,
  };
}

/** A `comment.added` event with overridable author / mentions / body / item. */
function commentEvent(
  overrides: Partial<{
    itemId: string;
    occurredAt: string;
    author: string;
    mentions: string[];
    body: string;
  }> = {}
): CommentAddedEvent {
  const itemId = overrides.itemId ?? 'DOR-1';
  const occurredAt = overrides.occurredAt ?? '2026-06-25T01:00:00.000Z';
  return {
    kind: 'comment.added',
    itemId,
    actor: overrides.author ?? REVIEWER,
    occurredAt,
    receivedVia: 'poll',
    dedupeKey: trackerEventDedupeKey('comment.added', itemId, occurredAt),
    raw: null,
    comment: {
      author: overrides.author ?? REVIEWER,
      mentions: overrides.mentions ?? [],
      body: overrides.body ?? 'go with option B',
    },
  };
}

/** Build an inbox candidate (event + current item + ownership + run). */
function candidate(overrides: Partial<InboxCandidate> = {}): InboxCandidate {
  return {
    event: commentEvent(),
    item: makeItem(),
    ownership: 'mine' as OwnershipClass,
    run: flowRun(),
    ...overrides,
  };
}

/** An inbox-only context with the given candidates + default identity/comments. */
function inboxCtx(
  candidates: InboxCandidate[],
  claimed?: Set<string>
): ReconcileContext<FlowReconcileInput> {
  return {
    now: 0,
    claimedItemIds: claimed,
    input: {
      inbox: {
        candidates,
        identity: IDENTITY,
        comments: DEFAULT_COMMENTS,
      } satisfies InboxReconcileInput,
    },
  };
}

// ─── the resume decision, surfaced through the reconciler ─────────────────────

describe('inboxReconciler — resume on a parked answer (rule 3)', () => {
  it('a non-agent reply on a parked item → resume carrying the FlowRun sessionId', async () => {
    const ctx = inboxCtx([candidate()]);
    expect(inboxReconciler.isDue(ctx)).toBe(true);

    const result = await inboxReconciler.run(ctx);
    expect(result.acted).toBe(true);
    expect(result.itemId).toBe('DOR-1');
    expect(result.summary).toMatch(/resume/);
    expect(result.summary).toContain('session-xyz'); // the --resume handle
    expect(result.summary).toContain('--resume');
  });

  it('falls back to thread-replay when there is no local FlowRun', async () => {
    const ctx = inboxCtx([candidate({ run: null })]);
    const result = await inboxReconciler.run(ctx);
    expect(result.acted).toBe(true);
    expect(result.summary).toMatch(/thread-replay/);
    expect(result.summary).not.toContain('--resume');
  });

  it('carries the event dedupeKey in the summary for the idempotent audit trail', async () => {
    const ctx = inboxCtx([candidate()]);
    const result = await inboxReconciler.run(ctx);
    expect(result.summary).toContain('comment.added:DOR-1:2026-06-25T01:00:00.000Z');
  });
});

describe('inboxReconciler — never resumes on the agent’s own reply (rule 1)', () => {
  it('an agent-authored (marker) reply yields NO action — identity-mode-agnostic', async () => {
    // Shared-account mode: author == AGENT and the marker is in the body. Rule 1
    // fires before rule 3, so the agent never resumes on its own write.
    const ownReply = candidate({
      event: commentEvent({ author: AGENT, body: `Still waiting. ${MARKER}` }),
    });
    const ctx = inboxCtx([ownReply]);
    expect(inboxReconciler.isDue(ctx)).toBe(false);

    const result = await inboxReconciler.run(ctx);
    expect(result.acted).toBe(false);
  });

  it('a stray comment on a NON-parked item does not resume (rule 3 is gated on the label)', async () => {
    const notParked = candidate({
      item: makeItem({ labels: [], agentDisposition: 'claimed' }),
      ownership: 'mine',
    });
    const ctx = inboxCtx([notParked]);
    expect(inboxReconciler.isDue(ctx)).toBe(false);
    const result = await inboxReconciler.run(ctx);
    expect(result.acted).toBe(false);
  });

  it('is not due when the inbox slice is absent', () => {
    expect(inboxReconciler.isDue({ now: 0, input: {} })).toBe(false);
  });

  it('skips an item already claimed earlier this tick (contention)', () => {
    const ctx = inboxCtx(
      [candidate({ item: makeItem({ identifier: 'DOR-1' }) })],
      new Set(['DOR-1'])
    );
    expect(inboxReconciler.isDue(ctx)).toBe(false);
  });

  it('resumes a sibling parked item when the first candidate is the agent’s own reply', async () => {
    const ctx = inboxCtx([
      candidate({
        event: commentEvent({ itemId: 'DOR-own', author: AGENT, body: `ping ${MARKER}` }),
        item: makeItem({ identifier: 'DOR-own' }),
      }),
      candidate({
        event: commentEvent({ itemId: 'DOR-real' }),
        item: makeItem({ identifier: 'DOR-real' }),
        run: flowRun({ identifier: 'DOR-real', sessionId: 'session-real' }),
      }),
    ]);
    const result = await inboxReconciler.run(ctx);
    expect(result.itemId).toBe('DOR-real');
    expect(result.summary).toContain('session-real');
  });
});

// ─── ordering: inbox (20) sorts after recovery (10) and before dispatch (30) ───

describe('inboxReconciler — priority placement', () => {
  it('defaultConfig.priority is 20', () => {
    expect(inboxReconciler.defaultConfig.priority).toBe(20);
  });

  it('sorts between recovery (10) and review (25) / dispatch (30) in the registry', () => {
    const ids = defaultRegistry()
      .list()
      .map((r) => r.id);
    expect(ids).toEqual(['recovery', 'inbox', 'review', 'dispatch', 'triage', 'hygiene']);
  });

  it('inbox(20) resumes DOR-1 so dispatch(30) stands down on it', async () => {
    /** A backlog-category, agent/ready WorkItem (claimable under default policy). */
    function readyItem(identifier: string): WorkItem {
      return {
        id: `node_${identifier}`,
        identifier,
        title: `Title ${identifier}`,
        description: '',
        type: 'task',
        stateCategory: 'backlog',
        stateName: 'Backlog',
        priority: 3,
        size: 'md',
        project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
        parent: null,
        relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
        labels: ['agent/ready'],
        assignee: undefined,
        agentDisposition: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    }

    const opts: DispatchOptions = { classifyOwnership: () => 'unassigned' };
    const ctx: ReconcileContext<FlowReconcileInput> = {
      now: 0,
      input: {
        // inbox sees DOR-1 as a parked answer; dispatch sees DOR-1 as ready work.
        inbox: {
          candidates: [candidate({ item: makeItem({ identifier: 'DOR-1' }) })],
          identity: IDENTITY,
          comments: DEFAULT_COMMENTS,
        },
        dispatch: {
          items: [readyItem('DOR-1')],
          config: {
            dispatch: DispatchSchema.parse({}),
            ownership: OwnershipSchema.parse({}),
            wipCap: WipCapSchema.parse({}),
          },
          opts,
        },
      },
    };

    const results = await runTick(defaultRegistry(), ctx);
    const inbox = results.find((r) => r.id === 'inbox');
    const dispatch = results.find((r) => r.id === 'dispatch');
    expect(inbox?.acted).toBe(true);
    expect(inbox?.itemId).toBe('DOR-1');
    // dispatch stood down: DOR-1 was already claimed by inbox, no other item.
    expect(dispatch?.acted).toBeFalsy();
  });
});
