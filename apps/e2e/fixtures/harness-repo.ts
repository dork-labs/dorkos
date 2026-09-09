/**
 * A repository staged on disk before an agent is registered against it, for the
 * one spec whose subject is what is IN an agent's folder.
 *
 * Every other fixture here seeds through the API, deliberately (see
 * `rooms-api.ts`). This one cannot: the Skills page reads a real directory —
 * a harness manifest, a skill in the canonical layer, a skill kept where only
 * Claude Code looks, a link whose skill somebody deleted — and there is no
 * endpoint that puts any of that there. So the tree is written first and the
 * agent is registered AT it, which is what `RoomsApi.registerAgent`'s `path`
 * option exists for.
 *
 * **Under this run's `agentRoot`, always.** `registerAgent` sends
 * `scanRoot: FIXTURE_AGENT_ROOT`, so the namespace the server derives is
 * `run-<runId>` only while the agent's path is inside this run's own root — a
 * tree staged anywhere else registers into a namespace belonging to nobody,
 * with no error to say so. The spec asserts the containment rather than
 * trusting it.
 *
 * **It cleans up after itself even though `RoomsApi.cleanup` would.** That is
 * belt and braces on purpose: the two fixtures are independent, a spec may
 * stage a repository and never register anything, and `rm -rf` of a directory
 * that is already gone is free.
 *
 * @module fixtures/harness-repo
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RoomsApi } from './rooms-api';

/**
 * The names the staged tree uses.
 *
 * Module-private: a spec reads them back off {@link StagedHarnessRepo} rather than
 * importing them, so the tree and the names can never be two lists.
 */
const HARNESS_REPO_SKILLS = {
  /** The skill in `.agents/skills` — Codex reads it there, Claude Code gets a link. */
  canonical: 'deploy-checklist',
  /** The skill kept in `.claude/skills` as a real directory — Codex cannot see it. */
  harnessNative: 'release-notes',
  /** The skill a `.claude/skills` link still points at and nothing else has. */
  deleted: 'retired-helper',
} as const;

/** What to put in the tree beyond the manifest and the canonical skill. */
export interface HarnessRepoOptions {
  /**
   * Stage a real `.claude/skills/<harnessNative>/` directory: a skill Claude
   * Code reads where it is and Codex cannot see, which is what makes a row
   * adoptable and fills the "Not shared with Codex" panel.
   */
  harnessNativeSkill?: boolean;
  /**
   * Stage `.claude/skills/<deleted>` as a link into `.agents/skills` with
   * nothing at the other end — the orphan a sync REMOVES, and the only way to
   * put the removal disclosure on screen.
   *
   * Deliberately not "delete a projected link": a link whose skill still exists
   * is drift the projection repairs, and the watcher (DOR-1850) may repair it
   * before a spec has looked.
   */
  orphanedLink?: boolean;
}

/**
 * A repository this fixture staged, as the spec refers to it.
 *
 * The two optional pieces are reached through accessors rather than as
 * `string | undefined` fields, and that is the point of them: a spec asking for
 * a part it did not stage should fail SAYING so. Passed straight into a
 * Playwright locator, an `undefined` narrowed away with `?? ''` becomes a role
 * name of `''` and the run spends five seconds timing out before reporting
 * that nothing is named the empty string, which is true and useless.
 */
export interface StagedHarnessRepo {
  /** Absolute path of the repository root — what an agent is registered at. */
  root: string;
  /** The skill in `.agents/skills`. */
  canonicalSkill: string;
  /** The repo-relative path the canonical skill is projected to for Claude Code. */
  projectedLink: string;
  /**
   * The skill kept in `.claude/skills`.
   *
   * @throws when the repository was staged without `harnessNativeSkill`.
   */
  harnessNativeSkill: () => string;
  /**
   * The repo-relative path of the dead link.
   *
   * @throws when the repository was staged without `orphanedLink`.
   */
  orphanedLink: () => string;
}

/**
 * A staged part, or a failure naming the option that was not passed.
 *
 * @param value - What `stage` recorded, if it staged this part at all.
 * @param option - The option that would have staged it.
 */
function staged(value: string | undefined, option: keyof HarnessRepoOptions): string {
  if (value === undefined) {
    throw new Error(
      `This repository was staged without \`${option}\`, so there is nothing to name. ` +
        `Pass \`{ ${option}: true }\` to harnessRepo.stage().`
    );
  }
  return value;
}

/** One `SKILL.md`, with the frontmatter every harness keys a skill by. */
function skillFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`;
}

/**
 * Stages repositories under one {@link RoomsApi}'s agent root and removes them
 * again.
 *
 * One instance per test, like every other fixture here, so nothing it writes
 * can outlive the test that asked for it.
 */
export class HarnessRepoApi {
  private readonly roomsApi: RoomsApi;
  private readonly staged: string[] = [];

  constructor(roomsApi: RoomsApi) {
    this.roomsApi = roomsApi;
  }

  /**
   * Write one repository and answer where everything in it is.
   *
   * The manifest enables `claude-code` and `codex` — two tools that disagree
   * about every skill in the tree, which is the whole point: Codex reads
   * `.agents/skills` natively and cannot see `.claude/skills` at all, so one
   * staged tree produces a projected row, a native row, an adoptable row and a
   * drop without staging anything twice.
   *
   * @param options - What to stage beyond the manifest and the canonical skill.
   * @returns The staged paths and names.
   */
  async stage(options: HarnessRepoOptions = {}): Promise<StagedHarnessRepo> {
    const root = join(this.roomsApi.agentRoot, `harness-${this.staged.length + 1}`);
    this.staged.push(root);

    await mkdir(join(root, '.agents', 'skills', HARNESS_REPO_SKILLS.canonical), {
      recursive: true,
    });
    await writeFile(
      join(root, '.agents', 'harness.manifest.json'),
      `${JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)}\n`
    );
    await writeFile(
      join(root, '.agents', 'skills', HARNESS_REPO_SKILLS.canonical, 'SKILL.md'),
      skillFile(HARNESS_REPO_SKILLS.canonical, 'What to check before you ship.')
    );

    // `.claude/skills` exists either way, so the two branches below differ only
    // in what is IN it — and so a tree with neither still reads as a project
    // Claude Code is set up for.
    await mkdir(join(root, '.claude', 'skills'), { recursive: true });

    let harnessNativeSkill: string | undefined;
    if (options.harnessNativeSkill === true) {
      const dir = join(root, '.claude', 'skills', HARNESS_REPO_SKILLS.harnessNative);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'SKILL.md'),
        skillFile(HARNESS_REPO_SKILLS.harnessNative, 'How this release is written up.')
      );
      harnessNativeSkill = HARNESS_REPO_SKILLS.harnessNative;
    }

    let orphanedLink: string | undefined;
    if (options.orphanedLink === true) {
      // Relative, the way the engine writes its own links, and pointing into
      // `.agents/skills` — both are conditions of the sweep recognising it as
      // one of ours rather than as somebody's own link (`authored-orphans.ts`).
      await symlink(
        join('..', '..', '.agents', 'skills', HARNESS_REPO_SKILLS.deleted),
        join(root, '.claude', 'skills', HARNESS_REPO_SKILLS.deleted)
      );
      orphanedLink = `.claude/skills/${HARNESS_REPO_SKILLS.deleted}`;
    }

    return {
      root,
      canonicalSkill: HARNESS_REPO_SKILLS.canonical,
      projectedLink: `.claude/skills/${HARNESS_REPO_SKILLS.canonical}`,
      harnessNativeSkill: () => staged(harnessNativeSkill, 'harnessNativeSkill'),
      orphanedLink: () => staged(orphanedLink, 'orphanedLink'),
    };
  }

  /**
   * Remove every repository this instance staged.
   *
   * Failures are swallowed for the reason `RoomsApi.cleanup` gives: teardown
   * runs after the test has decided its verdict, and a cleanup error reported
   * as a failure hides the real one.
   */
  async cleanup(): Promise<void> {
    for (const root of this.staged) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}
