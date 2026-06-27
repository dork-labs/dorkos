/**
 * Unit suite for the identity & ownership model (§7) — the one primitive
 * {@link classifyOwnership} plus {@link resolveIdentityMode}. Imports from the
 * relative module path (NOT the `@dorkos/flow` barrel), matching the other flow
 * suites — the orchestrator wires barrel exports later.
 *
 * Coverage: two-account vs shared-account (DETECTED) × {mine, reviewer, other,
 * unassigned}; mode detection (reviewer null / reviewer == agent / distinct);
 * the `identity.agent: "auto"` resolution contract (resolved identity in →
 * correct class); project-scope classification via `lead`; and the shared-mode
 * "never auto-claim a `mine` item without `agent/claimed`" rule.
 *
 * @see specs/unified-workflow-system/02-specification.md §7
 */

import { describe, expect, it } from 'vitest';
import { IdentitySchema } from '../config-schema.js';
import {
  classifyOwnership,
  resolveIdentityMode,
  SHARED_MODE_CLAIM_LABEL,
  type Identity,
} from '../identity.js';
import type { OwnershipClass, WorkItem } from '../work-item.js';

/** The resolved AGENT account id used across the suite. */
const AGENT = 'acct-agent';
/** A distinct resolved REVIEWER account id (two-account mode). */
const REVIEWER = 'acct-reviewer';
/** A third-party account (teammate / another agent) → the `other` class. */
const OTHER_ACCOUNT = 'acct-teammate';

/** Two-account identity: agent and reviewer are distinct resolved accounts. */
const TWO_ACCOUNT: Identity = { agent: AGENT, reviewer: REVIEWER, marker: '— 🤖 /flow' };
/** Shared-account identity: no distinct reviewer (`reviewer: null`). */
const SHARED: Identity = { agent: AGENT, reviewer: null, marker: '— 🤖 /flow' };

/** Build a fully-formed WorkItem with an overridable `assignee` (and others). */
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'node_DOR-1',
    identifier: 'DOR-1',
    title: 'Title',
    description: '',
    type: 'task',
    stateCategory: 'unstarted',
    stateName: 'Todo',
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

describe('resolveIdentityMode (§7 — DETECTED, not configured)', () => {
  it('detects shared mode when reviewer is null', () => {
    expect(resolveIdentityMode({ agent: AGENT, reviewer: null, marker: 'm' })).toBe('shared');
  });

  it('detects shared mode when reviewer equals agent', () => {
    expect(resolveIdentityMode({ agent: AGENT, reviewer: AGENT, marker: 'm' })).toBe('shared');
  });

  it('detects two-account mode when reviewer is a distinct account', () => {
    expect(resolveIdentityMode({ agent: AGENT, reviewer: REVIEWER, marker: 'm' })).toBe(
      'two-account'
    );
  });
});

describe('classifyOwnership — two-account mode × {mine, reviewer, other, unassigned}', () => {
  const cases: Array<{ name: string; assignee: string | undefined; expected: OwnershipClass }> = [
    { name: 'mine — assigned to the agent account', assignee: AGENT, expected: 'mine' },
    {
      name: 'reviewer — assigned to the distinct reviewer',
      assignee: REVIEWER,
      expected: 'reviewer',
    },
    { name: 'other — assigned to a third account', assignee: OTHER_ACCOUNT, expected: 'other' },
    { name: 'unassigned — no assignee', assignee: undefined, expected: 'unassigned' },
  ];

  for (const { name, assignee, expected } of cases) {
    it(name, () => {
      expect(classifyOwnership(makeItem({ assignee }), TWO_ACCOUNT)).toBe(expected);
    });
  }
});

describe('classifyOwnership — shared-account mode × {mine, reviewer, other, unassigned}', () => {
  // In shared mode `reviewer` collapses onto `agent`: an item on the shared
  // account is `mine` (NOT `reviewer`). `reviewer` is unreachable — there is no
  // distinct reviewer account to assign to.
  const cases: Array<{ name: string; assignee: string | undefined; expected: OwnershipClass }> = [
    { name: 'mine — assigned to the shared (agent) account', assignee: AGENT, expected: 'mine' },
    { name: 'other — assigned to a third account', assignee: OTHER_ACCOUNT, expected: 'other' },
    { name: 'unassigned — no assignee', assignee: undefined, expected: 'unassigned' },
  ];

  for (const { name, assignee, expected } of cases) {
    it(name, () => {
      expect(classifyOwnership(makeItem({ assignee }), SHARED)).toBe(expected);
    });
  }

  it('classifies a shared-account self-assignment as `mine`, never `reviewer`', () => {
    // Even with reviewer === agent explicitly, agent is checked first → `mine`.
    const sharedExplicit: Identity = { agent: AGENT, reviewer: AGENT, marker: 'm' };
    expect(classifyOwnership(makeItem({ assignee: AGENT }), sharedExplicit)).toBe('mine');
  });
});

describe('classifyOwnership — `identity.agent: "auto"` resolution contract (§7)', () => {
  it('classifies against the RESOLVED account (runtime resolves "auto" before calling)', () => {
    // The §9 default config carries `agent: "auto"`. The runtime resolves it via
    // the adapter's getCurrentUser BEFORE classification; this module only ever
    // sees the resolved id. Simulate the resolved identity and assert the class.
    const configDefault = IdentitySchema.parse({});
    expect(configDefault.agent).toBe('auto'); // sentinel in config, never seen here
    expect(configDefault.reviewer).toBeNull();

    const resolved: Identity = {
      agent: 'resolved-auth-account',
      reviewer: null,
      marker: configDefault.marker,
    };
    expect(classifyOwnership(makeItem({ assignee: 'resolved-auth-account' }), resolved)).toBe(
      'mine'
    );
    expect(classifyOwnership(makeItem({ assignee: OTHER_ACCOUNT }), resolved)).toBe('other');
    // `"auto"` is the unresolved sentinel — it must never match a real assignee.
    expect(classifyOwnership(makeItem({ assignee: 'auto' }), resolved)).toBe('other');
  });
});

describe('classifyOwnership — project scope (§7, ownership.scope: ["issues","projects"])', () => {
  function makeItemWithLead(lead: string | undefined): WorkItem {
    return makeItem({
      assignee: OTHER_ACCOUNT, // assignee differs from lead to prove scope is honored
      project: { id: 'proj_a', name: 'Project A', stateCategory: 'started', lead },
    });
  }

  it('classifies a project by its `lead` (mine) — independent of the issue assignee', () => {
    expect(classifyOwnership(makeItemWithLead(AGENT), TWO_ACCOUNT, 'projects')).toBe('mine');
  });

  it('classifies a project lead as `reviewer` in two-account mode', () => {
    expect(classifyOwnership(makeItemWithLead(REVIEWER), TWO_ACCOUNT, 'projects')).toBe('reviewer');
  });

  it('classifies a project lead as `other` for a third account', () => {
    expect(classifyOwnership(makeItemWithLead(OTHER_ACCOUNT), TWO_ACCOUNT, 'projects')).toBe(
      'other'
    );
  });

  it('classifies a project with no lead as `unassigned`', () => {
    expect(classifyOwnership(makeItemWithLead(undefined), TWO_ACCOUNT, 'projects')).toBe(
      'unassigned'
    );
  });

  it('classifies a project lead as `mine` in shared mode', () => {
    expect(classifyOwnership(makeItemWithLead(AGENT), SHARED, 'projects')).toBe('mine');
  });

  it('treats a missing project as `unassigned` under project scope', () => {
    const noProject = makeItem({ project: undefined });
    expect(classifyOwnership(noProject, TWO_ACCOUNT, 'projects')).toBe('unassigned');
  });

  it('defaults to issue scope when no scope arg is given', () => {
    // Issue assigned to agent, project led by a teammate → issue scope sees `mine`.
    const item = makeItemWithLead(OTHER_ACCOUNT);
    const issueAssigned = { ...item, assignee: AGENT };
    expect(classifyOwnership(issueAssigned, TWO_ACCOUNT)).toBe('mine');
  });
});

describe('shared-mode claim rule — `mine` is not auto-claimable without `agent/claimed`', () => {
  it('exposes the canonical claim label', () => {
    expect(SHARED_MODE_CLAIM_LABEL).toBe('agent/claimed');
  });

  it('classifies a shared-account item as `mine` regardless of the claim label', () => {
    // classifyOwnership reports raw ownership; the label gate lives in the claim
    // step, NOT in the primitive. A shared-account item is `mine` whether or not
    // it carries agent/claimed — the consumer (dispatch/claim) applies the gate.
    const unclaimed = makeItem({ assignee: AGENT, labels: [] });
    const claimed = makeItem({ assignee: AGENT, labels: [SHARED_MODE_CLAIM_LABEL] });
    expect(classifyOwnership(unclaimed, SHARED)).toBe('mine');
    expect(classifyOwnership(claimed, SHARED)).toBe('mine');
  });

  it('models the shared-mode auto-claim gate a consumer must apply on top of `mine`', () => {
    // Documents the contract for the claim step: in shared mode, a `mine` item is
    // only auto-claimable when it ALSO carries agent/claimed (the assignee alone
    // is ambiguous — agent and human are the same account).
    const isSharedAutoClaimable = (item: WorkItem, identity: Identity): boolean =>
      resolveIdentityMode(identity) === 'shared'
        ? classifyOwnership(item, identity) === 'mine' &&
          item.labels.includes(SHARED_MODE_CLAIM_LABEL)
        : classifyOwnership(item, identity) === 'mine';

    expect(isSharedAutoClaimable(makeItem({ assignee: AGENT, labels: [] }), SHARED)).toBe(false);
    expect(
      isSharedAutoClaimable(
        makeItem({ assignee: AGENT, labels: [SHARED_MODE_CLAIM_LABEL] }),
        SHARED
      )
    ).toBe(true);
    // Two-account mode: the assignee alone is unambiguous, no label required.
    expect(isSharedAutoClaimable(makeItem({ assignee: AGENT, labels: [] }), TWO_ACCOUNT)).toBe(
      true
    );
  });
});
