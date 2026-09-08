/**
 * The shared repository generator for the engine's property tests (T0).
 *
 * `arbRepo()` produces a whole small repository — authored skills, plugins,
 * authored hooks, a random enabled-harness subset — and then stages **hostile
 * occupants** on top of it: a file somebody wrote by hand at a generated hook
 * target, a real directory at a skill link target, a widowed ownership sidecar,
 * and a **dead symlink** at one of the three kinds of target the engine writes
 * (a `generate` target, a `scaffold` target, a `symlink` target). Each generated
 * repo is materialised into a real temp dir; nothing here is mocked.
 *
 * It lives in its own module because more than one property file reads it:
 * `apply-ownership.property.test.ts` (P3, P4) and
 * `orphaned-links.property.test.ts` (P2, P2b). Keeping one generator is the
 * point — a hostile shape added for one property immediately hardens the other.
 *
 * @module __tests__/properties/arb-repo
 */
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import {
  CODEX_HOOKS_TARGET,
  CURSOR_HOOKS_TARGET,
  COPILOT_HOOKS_TARGET,
} from '../../generate/hooks.js';
import { writeFileAt, writeJsonAt } from '../journeys/stage.js';

/** The sidecar suffix the engine writes beside a generated hook file. */
export const SIDECAR_SUFFIX = '.dorkos-generated';

/** Which harness owns each generated hook target — the map the sweep must respect. */
export const TARGET_HARNESS: Record<string, HarnessId> = {
  [CODEX_HOOKS_TARGET]: 'codex',
  [CURSOR_HOOKS_TARGET]: 'cursor',
  [COPILOT_HOOKS_TARGET]: 'copilot',
};

/** How a staged occupant's sidecar relates to the file beside it. */
export type SidecarState = 'none' | 'matching' | 'stale';

/**
 * What the staged occupant's bytes look like.
 *
 * `vendor` is unmistakably a person's — the documented wrapper shape with a
 * distinctive command. `bare` is the engine's own pre-sidecar output shape, the
 * one case where migration rule 2 may legitimately overwrite a sidecar-less
 * file, so a generated repo has to be able to hold one.
 */
export type OccupantShape = 'vendor' | 'bare';

/**
 * Which kind of target a staged dead symlink sits at.
 *
 * The three are not interchangeable, because the engine answers each one
 * differently: a dead link at a `generate` target is drift the engine replaces,
 * at a `scaffold` target it is an absent pointer, and at a `symlink` target
 * under `.claude/skills` that points into `.agents/skills` it is an ORPHAN — the
 * skill it pointed at is gone, and the engine prunes it.
 */
export type DanglingKind = 'generate' | 'scaffold' | 'skill';

/** The repo-relative path each {@link DanglingKind} stages its dead link at. */
const DANGLING_TARGETS: Record<DanglingKind, string> = {
  generate: CODEX_HOOKS_TARGET,
  scaffold: '.claude/CLAUDE.md',
  skill: '.claude/skills/zz-gone',
};

/**
 * The link text each staged dead link carries.
 *
 * The generate/scaffold links point at a sibling path that does not exist, so a
 * write THROUGH the link would land somewhere real and visible rather than
 * throwing — the engine has to remove the link, not follow it. The skill link
 * points into `.agents/skills/` at a name no generated repo ever has, which is
 * exactly the shape a removed authored skill leaves behind.
 */
const DANGLING_LINK_TEXT: Record<DanglingKind, string> = {
  generate: 'nowhere-codex-hooks.json',
  scaffold: 'nowhere-claude.md',
  skill: '../../.agents/skills/zz-gone',
};

/** One generated repository, before it is written to disk. */
export interface RepoSpec {
  /** Authored skill names under `.agents/skills`. */
  skills: string[];
  /** Project-scoped installed plugins. */
  plugins: { name: string; skills: string[]; hooks: boolean }[];
  /** Whether `.claude/settings.json` carries authored hooks. */
  authoredHooks: boolean;
  /** The manifest's enabled harnesses (may be empty). */
  harnesses: HarnessId[];
  /** A hand-written file at one generated hook target, or none. */
  occupant: { target: string; sidecar: SidecarState; shape: OccupantShape } | null;
  /** A sidecar with no file beside it, at the Copilot target. */
  widowedSidecar: boolean;
  /** Whether a real directory occupies a Claude skill link target. */
  dirOccupant: boolean;
  /** A dead symlink staged at one kind of engine target, or none. */
  dangling: DanglingKind | null;
}

/** What {@link materialise} actually staged for {@link RepoSpec.dangling}. */
export interface StagedDangling {
  /** Which kind of target the dead link sits at. */
  kind: DanglingKind;
  /** Its repo-relative path. */
  path: string;
}

/** A small name alphabet, so collisions between authored and plugin skills happen. */
const SKILL_NAMES = ['a', 'b', 'c', 'd'] as const;

/**
 * The generator: a whole small repo, hostile occupants included.
 *
 * @returns an arbitrary over {@link RepoSpec}.
 */
export function arbRepo(): fc.Arbitrary<RepoSpec> {
  return fc.record({
    skills: fc.uniqueArray(fc.constantFrom(...SKILL_NAMES), { maxLength: 4 }),
    plugins: fc.uniqueArray(
      fc.record({
        name: fc.constantFrom('acme', 'flow'),
        skills: fc.uniqueArray(fc.constantFrom(...SKILL_NAMES), { maxLength: 2 }),
        hooks: fc.boolean(),
      }),
      { maxLength: 2, selector: (p) => p.name }
    ),
    authoredHooks: fc.boolean(),
    harnesses: fc.subarray([...HARNESS_IDS]),
    occupant: fc.option(
      fc.record({
        target: fc.constantFrom(CODEX_HOOKS_TARGET, CURSOR_HOOKS_TARGET, COPILOT_HOOKS_TARGET),
        sidecar: fc.constantFrom<SidecarState>('none', 'matching', 'stale'),
        shape: fc.constantFrom<OccupantShape>('vendor', 'bare'),
      }),
      { nil: null }
    ),
    widowedSidecar: fc.boolean(),
    dirOccupant: fc.boolean(),
    dangling: fc.option(fc.constantFrom<DanglingKind>('generate', 'scaffold', 'skill'), {
      nil: null,
    }),
  });
}

/**
 * The bytes a staged occupant holds.
 *
 * `vendor` is unmistakably somebody's own — the documented wrapper shape with a
 * distinctive command, which the engine may never adopt or rewrite. `bare` is
 * the engine's own pre-sidecar output, which migration rule 2 IS allowed to
 * rewrite when no sidecar has ever been written beside it.
 *
 * @param target - the repo-relative hook target the occupant sits at.
 * @param shape - which of the two shapes to write.
 * @returns the exact bytes to stage.
 */
export function occupantContent(target: string, shape: OccupantShape = 'vendor'): string {
  const body =
    shape === 'bare'
      ? { Stop: [{ hooks: [{ type: 'command', command: `echo LEGACY ${target}` }] }] }
      : {
          version: 1,
          description: `hand-written ${target}`,
          hooks: { stop: [{ type: 'command', command: `echo MINE ${target}` }] },
        };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Whether the engine is entitled to rewrite this occupant: only its own legacy
 * bare map, and only at the Codex path, and only with no sidecar beside it.
 *
 * @param occupant - the staged occupant, or null.
 * @returns `true` when migration rule 2 covers it.
 */
export function isAdoptableLegacy(occupant: RepoSpec['occupant']): boolean {
  return (
    occupant !== null &&
    occupant.shape === 'bare' &&
    occupant.sidecar === 'none' &&
    occupant.target === CODEX_HOOKS_TARGET
  );
}

/** What {@link materialise} returns: the two temp dirs and what it staged in them. */
export interface MaterialisedRepo {
  /** Absolute path of the generated repository. */
  repoRoot: string;
  /** Absolute path of an empty dork home (no global plugins). */
  dorkHome: string;
  /** Absolute path of the staged hand-written occupant, when there is one. */
  occupantAbs?: string;
  /** The dead link that was actually staged, when there is one. */
  dangling?: StagedDangling;
}

/**
 * Materialise a generated repo spec into a fresh temp dir.
 *
 * @param spec - the generated repository to write.
 * @returns the staged repo, its dork home, and what hostile content landed.
 */
function materialise(spec: RepoSpec): MaterialisedRepo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-prop-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-prop-home-'));

  writeJsonAt(join(repoRoot, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: spec.harnesses,
  });
  writeFileAt(join(repoRoot, 'AGENTS.md'), '# Project\n');
  for (const name of spec.skills) {
    writeFileAt(join(repoRoot, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  if (spec.authoredHooks) {
    writeJsonAt(join(repoRoot, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo authored' }] }] },
    });
  }
  for (const plugin of spec.plugins) {
    const dir = join(repoRoot, '.dork', 'plugins', plugin.name);
    writeJsonAt(join(dir, '.dork', 'manifest.json'), {
      schemaVersion: 1,
      name: plugin.name,
      version: '1.0.0',
      type: 'plugin',
      description: `${plugin.name} plugin`,
      layers: ['skills', 'hooks'],
    });
    for (const skill of plugin.skills) {
      writeFileAt(join(dir, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    }
    if (plugin.hooks) {
      writeJsonAt(join(dir, 'hooks', 'hooks.json'), {
        Stop: [{ hooks: [{ type: 'command', command: `echo ${plugin.name}` }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo unmappable' }] }],
      });
    }
  }

  if (spec.widowedSidecar) {
    // A sidecar whose file is gone: the sweep may take it, alone.
    writeFileAt(
      `${join(repoRoot, COPILOT_HOOKS_TARGET)}${SIDECAR_SUFFIX}`,
      `${createHash('sha256').update('a file that is no longer here').digest('hex')}\n`
    );
  }

  let occupantAbs: string | undefined;
  if (spec.occupant) {
    occupantAbs = join(repoRoot, spec.occupant.target);
    const content = occupantContent(spec.occupant.target, spec.occupant.shape);
    writeFileAt(occupantAbs, content);
    if (spec.occupant.sidecar !== 'none') {
      const digested = spec.occupant.sidecar === 'matching' ? content : 'something else';
      writeFileAt(
        `${occupantAbs}${SIDECAR_SUFFIX}`,
        `${createHash('sha256').update(digested).digest('hex')}\n`
      );
    }
  }

  if (spec.dirOccupant && spec.skills.length > 0 && spec.harnesses.includes('claude-code')) {
    writeFileAt(
      join(repoRoot, '.claude', 'skills', spec.skills[0], 'precious.md'),
      '# do not delete\n'
    );
  }

  // The dead link goes on last, and only where nothing else is: two hostile
  // shapes at one path would make every assertion about that path ambiguous.
  let dangling: StagedDangling | undefined;
  if (spec.dangling && spec.occupant?.target !== DANGLING_TARGETS[spec.dangling]) {
    const rel = DANGLING_TARGETS[spec.dangling];
    const abs = join(repoRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    symlinkSync(DANGLING_LINK_TEXT[spec.dangling], abs);
    dangling = { kind: spec.dangling, path: rel };
  }

  return { repoRoot, dorkHome, occupantAbs, dangling };
}

/**
 * Run `body` against a materialised repo, always cleaning both temp dirs up.
 *
 * @param spec - the generated repository to stage.
 * @param body - the property body, given the staged paths.
 */
export function withRepo(spec: RepoSpec, body: (dirs: MaterialisedRepo) => void): void {
  const dirs = materialise(spec);
  try {
    body(dirs);
  } finally {
    for (const d of [dirs.repoRoot, dirs.dorkHome]) rmSync(d, { recursive: true, force: true });
  }
}

/** fast-check settings: modest run count, fixed seed so a failure is reproducible. */
export const RUNS = { numRuns: 40, seed: 20260907 } as const;
