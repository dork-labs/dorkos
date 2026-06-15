import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  TasksFileSchema,
  TaskSchema,
  ProvenanceSchema,
  isPromotableToSubIssue,
  normalizeSize,
  type Task,
} from '../tasks-schema.js';

// src/__tests__ -> src -> packages/flow -> packages -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const tasksFilePath = path.join(repoRoot, 'specs', 'unified-workflow-system', '03-tasks.json');

function readTasksFile(): unknown {
  return JSON.parse(readFileSync(tasksFilePath, 'utf8'));
}

/** A minimal valid task; spread in overrides per assertion. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '1.6',
    phase: 1,
    phaseName: 'P1 — Extract & thin',
    subject: 'Extend the schema',
    description: 'Add issue/parentIssue.',
    activeForm: 'Extending the schema',
    size: 'medium',
    priority: 'high',
    dependencies: [],
    parallelWith: [],
    ...overrides,
  };
}

describe('TasksFileSchema — round-tripping the real 03-tasks.json', () => {
  it('parses the on-disk specs/unified-workflow-system/03-tasks.json', () => {
    const parsed = TasksFileSchema.parse(readTasksFile());
    expect(parsed.slug).toBe('unified-workflow-system');
    expect(parsed.tasks.length).toBeGreaterThan(0);
  });

  it('round-trips the file content unchanged (defaults fill, nothing drops)', () => {
    const onDisk = readTasksFile() as Record<string, unknown>;
    const parsed = TasksFileSchema.parse(onDisk);
    // Every task carries dependencies/parallelWith on disk, and the file has no
    // top-level `issues` list — so the parse output is byte-equivalent JSON.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(onDisk);
  });
});

describe('TaskSchema — issue / parentIssue optional fields', () => {
  it('parses a task with no issue mapping (the common checklist case)', () => {
    const task = TaskSchema.parse(makeTask());
    expect(task.issue).toBeUndefined();
    expect(task.parentIssue).toBeUndefined();
  });

  it('parses a task carrying issue and parentIssue', () => {
    const task = TaskSchema.parse(makeTask({ issue: 'DOR-200', parentIssue: 'DOR-100' }));
    expect(task.issue).toBe('DOR-200');
    expect(task.parentIssue).toBe('DOR-100');
  });

  it('round-trips the new fields through the full document', () => {
    const promoted = makeTask({ id: '2.1', size: 'xl', issue: 'DOR-201', parentIssue: 'DOR-100' });
    const doc = {
      spec: 'specs/x/02-specification.md',
      slug: 'x',
      generatedAt: '2026-06-14T00:00:00.000Z',
      mode: 'full',
      lastDecomposeDate: null,
      tasks: [makeTask(), promoted],
    };
    const parsed = TasksFileSchema.parse(doc);
    expect(parsed.tasks[1]?.issue).toBe('DOR-201');
    expect(parsed.tasks[1]?.parentIssue).toBe('DOR-100');
  });
});

describe('TasksFileSchema — rejects a flat top-level issues list (§8)', () => {
  it('rejects a sibling `issues: []` (strict — would reintroduce drift)', () => {
    const doc = {
      spec: 'specs/x/02-specification.md',
      slug: 'x',
      generatedAt: '2026-06-14T00:00:00.000Z',
      mode: 'full',
      lastDecomposeDate: null,
      tasks: [makeTask()],
      issues: [{ id: 'DOR-1', task: '1.6' }],
    };
    expect(TasksFileSchema.safeParse(doc).success).toBe(false);
  });

  it('the real on-disk file has no top-level `issues` key', () => {
    const onDisk = readTasksFile() as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('issues');
  });
});

describe('isPromotableToSubIssue — fires only at size >= "xl"', () => {
  it('promotes a canonical xl task', () => {
    expect(isPromotableToSubIssue({ size: 'xl' })).toBe(true);
  });

  it('does NOT promote sizes below xl (canonical or legacy)', () => {
    for (const size of ['xs', 'sm', 'md', 'lg', 'small', 'medium', 'large'] as const) {
      expect(isPromotableToSubIssue({ size })).toBe(false);
    }
  });

  it('honors a lowered threshold', () => {
    expect(isPromotableToSubIssue({ size: 'lg' }, 'lg')).toBe(true);
    expect(isPromotableToSubIssue({ size: 'large' }, 'lg')).toBe(true);
    expect(isPromotableToSubIssue({ size: 'md' }, 'lg')).toBe(false);
  });

  it('normalizes the legacy size vocabulary onto the canonical scale', () => {
    expect(normalizeSize('small')).toBe('sm');
    expect(normalizeSize('medium')).toBe('md');
    expect(normalizeSize('large')).toBe('lg');
    expect(normalizeSize('xl')).toBe('xl');
  });

  it('no task in the real file is promotable at the default xl threshold', () => {
    const parsed = TasksFileSchema.parse(readTasksFile());
    expect(parsed.tasks.every((t) => !isPromotableToSubIssue(t))).toBe(true);
  });
});

describe('ProvenanceSchema — names exactly one tracker home (§8)', () => {
  it('parses an issue-homed block (small spec / ADR / research)', () => {
    const p = ProvenanceSchema.parse({ tracker: 'linear', issue: 'DOR-89' });
    expect(p.issue).toBe('DOR-89');
    expect(p.project).toBeUndefined();
  });

  it('parses a project-homed block (large spec)', () => {
    const p = ProvenanceSchema.parse({ tracker: 'linear', project: 'proj_abc123' });
    expect(p.project).toBe('proj_abc123');
    expect(p.issue).toBeUndefined();
  });

  it('rejects naming BOTH issue and project', () => {
    const result = ProvenanceSchema.safeParse({
      tracker: 'linear',
      issue: 'DOR-89',
      project: 'proj_abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects naming NEITHER issue nor project', () => {
    expect(ProvenanceSchema.safeParse({ tracker: 'linear' }).success).toBe(false);
  });

  it('rejects an unknown tracker', () => {
    expect(ProvenanceSchema.safeParse({ tracker: 'jira', issue: 'X-1' }).success).toBe(false);
  });
});
