/**
 * Stage → projection round-trip (spec §1, §8, §10; task 2.5).
 *
 * The v1 PM adapter is a PROSE contract (the `linear-adapter` SKILL.md), so a
 * stage *transition* — `transition(item, stage)`: "set the stage's `stage/*`
 * label and, when the stage carries one, its `stateCategory`" — has no TS class
 * to unit-test. Its single source of truth is instead the `stages` CONFIG in
 * `@dorkos/flow` (`StagesSchema`), which the adapter reads to know what to
 * project. This test pins that config projection: each stage maps to its
 * documented `{ command, label, stateCategory }`, and the resolved defaults
 * match the on-disk `.agents/flow/config.json` the engine actually runs on.
 *
 * The load-bearing rows (spec §9 / §10):
 *   - `execute` / `verify` → `stateCategory: "started"`, with a driving command.
 *   - `review` → `{ stateCategory: "started", humanGate: true }`, and NO command
 *     (the human gate is not agent-driven).
 *   - `done` → `stateCategory: "completed"`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { StagesSchema, type Stage } from '../config-schema.js';

// src/__tests__ -> src -> packages/flow -> packages -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const configPath = path.join(repoRoot, '.agents', 'flow', 'config.json');

/**
 * The projection a stage transition writes onto a work item. Mirrors the
 * adapter's `transition(item, stage)` contract: always the `stage/*` label
 * (when the stage carries one) and, when present, the `stateCategory`.
 */
interface StageProjection {
  label?: string;
  stateCategory?: Stage['stateCategory'];
  command?: string;
  humanGate: boolean;
}

/** Project a resolved stage definition the way the adapter would. */
function project(stage: Stage): StageProjection {
  return {
    label: stage.label,
    stateCategory: stage.stateCategory,
    command: stage.command,
    humanGate: stage.humanGate ?? false,
  };
}

/** The full §9-resolved stage spine, the engine's source of truth. */
const stages = StagesSchema.parse({});

/**
 * The documented stage → projection table (spec §9 / §10). One row per stage,
 * keyed by stage name. `command: null` means the stage is not agent-driven.
 */
const PROJECTION_TABLE: Record<
  keyof typeof stages,
  { label: string | null; stateCategory: Stage['stateCategory'] | null; humanGate: boolean }
> = {
  capture: { label: 'stage/capture', stateCategory: null, humanGate: false },
  triage: { label: 'stage/triage', stateCategory: null, humanGate: false },
  ideate: { label: 'stage/ideate', stateCategory: null, humanGate: false },
  specify: { label: 'stage/specify', stateCategory: null, humanGate: false },
  decompose: { label: 'stage/decompose', stateCategory: null, humanGate: false },
  execute: { label: 'stage/execute', stateCategory: 'started', humanGate: false },
  verify: { label: 'stage/verify', stateCategory: 'started', humanGate: false },
  review: { label: null, stateCategory: 'started', humanGate: true },
  done: { label: 'stage/done', stateCategory: 'completed', humanGate: false },
};

describe('stage → projection round-trip (config-driven)', () => {
  it.each(Object.keys(PROJECTION_TABLE) as Array<keyof typeof stages>)(
    'projects `%s` to its documented stage/* label + stateCategory',
    (name) => {
      const expected = PROJECTION_TABLE[name];
      const actual = project(stages[name]);

      if (expected.label === null) {
        expect(actual.label).toBeUndefined();
      } else {
        expect(actual.label).toBe(expected.label);
      }

      if (expected.stateCategory === null) {
        expect(actual.stateCategory).toBeUndefined();
      } else {
        expect(actual.stateCategory).toBe(expected.stateCategory);
      }

      expect(actual.humanGate).toBe(expected.humanGate);
    }
  );

  it('execute and verify both transition into the `started` category with a driving command', () => {
    for (const name of ['execute', 'verify'] as const) {
      const p = project(stages[name]);
      expect(p.stateCategory).toBe('started');
      expect(p.command).toBe(`/flow:${name}`);
      expect(p.humanGate).toBe(false);
    }
  });

  it('review is the human gate: `started` + humanGate, with NO command and NO stage label', () => {
    const p = project(stages.review);
    expect(p.stateCategory).toBe('started');
    expect(p.humanGate).toBe(true);
    expect(p.command).toBeUndefined();
    expect(p.label).toBeUndefined();
  });

  it('done projects into the `completed` category', () => {
    const p = project(stages.done);
    expect(p.stateCategory).toBe('completed');
    expect(p.command).toBe('/flow:done');
  });

  it('every projected stateCategory is a valid tracker state category', () => {
    const valid = new Set(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
    for (const stage of Object.values(stages)) {
      if (stage.stateCategory !== undefined) {
        expect(valid.has(stage.stateCategory)).toBe(true);
      }
    }
  });

  it('the resolved defaults match the on-disk .agents/flow/config.json stages', () => {
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      stages: Record<string, unknown>;
    };
    const fromDisk = StagesSchema.parse(onDisk.stages);
    // The config the engine runs on is exactly the §9-resolved spine this test pins.
    expect(fromDisk).toEqual(stages);
  });
});
