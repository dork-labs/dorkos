/**
 * Doc-completeness guard for the `linear-adapter` skill (spec §3; task 1.1).
 *
 * The v1 `PMClient` is a PROSE contract — a SKILL.md the agent reads and follows,
 * not executable code. A prose contract has no compiler to keep it complete, so
 * this cheap structural test pins that the contract documents all 13 capability
 * verbs, the core `WorkItem` fields, and the load-bearing invariants. If the
 * adapter shape (spec §3) changes, this test is the early warning that the prose
 * drifted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// src/__tests__ -> src -> engine -> flow -> .agents -> repo root
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..'
);
const skillPath = path.join(repoRoot, '.agents', 'flow', 'skills', 'linear-adapter', 'SKILL.md');

const skill = readFileSync(skillPath, 'utf8');

/** The 13 capability verbs the generic layer knows (spec §3). */
const VERBS = [
  'getCurrentUser',
  'getProjects',
  'getEligibleWork',
  'getInbox',
  'getRelations',
  'claim',
  'transition',
  'comment',
  'assignToHuman',
  'attachEvidence',
  'needsInput',
  'link',
  'createSubIssue',
] as const;

/** The core `WorkItem` normalization fields (spec §3). */
const WORK_ITEM_FIELDS = [
  'id',
  'identifier',
  'title',
  'description',
  'type',
  'stateCategory',
  'stateName',
  'priority',
  'size',
  'project',
  'parent',
  'relations',
  'labels',
  'assignee',
  'agentDisposition',
] as const;

describe('linear-adapter SKILL.md — prose-contract completeness', () => {
  it('has valid skill frontmatter (name + description)', () => {
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^name:\s*linear-adapter\s*$/m);
    expect(skill).toMatch(/^description:\s*.+/m);
  });

  it.each(VERBS)('documents the `%s` verb', (verb) => {
    expect(skill).toContain(verb);
  });

  it.each(WORK_ITEM_FIELDS)('documents the WorkItem field `%s`', (field) => {
    expect(skill).toContain(field);
  });

  it('documents stateCategory matching on CATEGORY, never on display name', () => {
    // The load-bearing rule: branch on category, not the team-customizable name.
    expect(skill).toMatch(/categor/i);
    expect(skill).toMatch(
      /never on (display )?name|never on the display name|NEVER ON DISPLAY NAME/i
    );
    for (const category of ['backlog', 'unstarted', 'started', 'completed', 'canceled']) {
      expect(skill).toContain(category);
    }
  });

  it('documents the agent/* labels as the durable state machine (not the plan field)', () => {
    expect(skill).toMatch(/agent\/\*/);
    expect(skill).toMatch(/state machine/i);
    for (const label of ['agent/ready', 'agent/claimed', 'agent/completed', 'agent/needs-input']) {
      expect(skill).toContain(label);
    }
  });

  it('documents the getInbox entry shape { item, comment: { author, mentions[], body } }', () => {
    for (const token of ['item', 'comment', 'author', 'mentions', 'body']) {
      expect(skill).toContain(token);
    }
  });

  it('documents needsInput as label + comment + assign-to-human + stop', () => {
    expect(skill).toContain('agent/needs-input');
    expect(skill).toMatch(/assign/i);
    expect(skill).toMatch(/\bstop\b/i);
  });

  it('documents graceful degradation for trackers lacking stateCategory/priority/size', () => {
    expect(skill).toMatch(/graceful degradation/i);
    expect(skill).toMatch(/neutral/i);
  });

  it('documents both Linear access paths (MCP primary + Composio fallback, personal account)', () => {
    expect(skill).toMatch(/mcp__(plugin_)?linear/);
    expect(skill).toMatch(/composio/i);
    expect(skill).toContain('--account personal');
    expect(skill).toMatch(/artblocks/); // the never-touch warning is present
  });

  it('frames itself as a prose contract that P5 promotes into a typed PMClient', () => {
    expect(skill).toMatch(/prose contract/i);
    expect(skill).toContain('PMClient');
    expect(skill).toMatch(/P5/);
  });
});
