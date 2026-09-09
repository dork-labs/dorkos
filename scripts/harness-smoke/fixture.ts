/**
 * The fixture the smoke asks a real harness about — staged through the journey
 * DSL, then projected by the real engine.
 *
 * Nothing here re-implements the DSL. `stageRepo` (`@dorkos/harness/journeys`,
 * DOR-1848) is the one place a fixture repository is described, and this module
 * is a caller of it: it names the shapes `plans/harness-sync-test-plan.md` §8
 * lists per harness, hands them to `stageRepo`, and then runs the real
 * `project()` + `applyPlan()` over the result. If the DSL and the smoke ever
 * disagreed about what "a realistic repo" is, the journeys would be testing one
 * tree and the harness smoke another, which is the failure this import exists to
 * prevent.
 *
 * ## The two things the smoke adds to a journey fixture
 *
 * A journey asserts the tree. The smoke asserts a READER, so it needs two
 * artifacts a journey has no use for:
 *
 * - **Nonces.** A projected hook's command is `touch <nonce>` and one skill's
 *   body says "run `touch <nonce>` and nothing else". The oracle is the file on
 *   disk. The two halves are NOT equally strong, and the report says so: a model
 *   cannot fake a hook firing, so the hook nonces are proof; a skill nonce is
 *   proof of INJECTION only on a harness whose file-read tools can be denied,
 *   and only one of the three has a per-tool deny. See
 *   `harnesses.ts`'s `FileReadDenial` — where reads are not denied, the prompt
 *   names the skill and the model can simply open `SKILL.md`, so the nonce
 *   corroborates rather than proves and SK-08/SK-09 are not cited.
 * - **A sentinel.** One improbable token inside `AGENTS.md`, so the instructions
 *   projection has a corroborating (never deciding) signal.
 *
 * Both live OUTSIDE the repository, under the run's own sandbox: a nonce written
 * into the fixture would sit inside the tree the coverage walk reads, and a
 * sentinel file there would be one more thing the projection diff has to explain.
 *
 * ## Why the shapes differ per harness
 *
 * §8 asks different questions of each binary, and two of them need mutually
 * exclusive trees: Claude Code and Codex are asked what a repository with an
 * `AGENTS.md` does, and OpenCode is asked what one with only a `CLAUDE.md` does
 * (its documented fallback). A single fixture cannot be both, so
 * {@link fixtureSpecFor} is a function of the harness and says so per field.
 *
 * ## Why the engine comes from `dist` and the DSL from source
 *
 * `project()` and `applyPlan()` are imported from `packages/harness/dist`, so
 * the smoke asks a binary about the tree the BUILT engine writes — which is what
 * a person's `dorkos harness sync` actually runs. It also keeps
 * `pnpm typecheck:scripts` honest: `scripts/tsconfig.json` is stricter than the
 * packages' own (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), and
 * tsc checks every file an import reaches, so importing the engine's SOURCE from
 * here would report a dozen errors in `packages/harness` and `packages/marketplace`
 * against options those packages never opted into. A `.d.ts` is not re-checked.
 *
 * `stageRepo` has no `dist` — `tsconfig.build.json` excludes `__tests__` on
 * purpose, and the package's `exports` map publishes `./journeys` as raw
 * TypeScript for exactly this reason (its docstring: "a fixture kit shared by
 * two packages has to be reachable from both"). Its own two modules type-check
 * clean under the stricter options, so importing them by path costs nothing.
 * Build the engine before running the smoke; `run.sh` says so if you have not.
 *
 * @module harness-smoke/fixture
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { project } from '../../packages/harness/dist/index.js';
import {
  stageRepo,
  writeFileAt,
  type StageRepoSpec,
} from '../../packages/harness/src/__tests__/journeys/index.js';
import { applyPlan } from '../../packages/harness/dist/apply/apply.js';
import type { SmokeHarness } from './harnesses.js';

/**
 * The token the instructions oracle looks for. Improbable on purpose: a harness
 * that pulled `AGENTS.md` in reproduces it, and nothing else on the machine
 * contains it.
 */
export const INSTRUCTIONS_SENTINEL = 'dorkos-harness-smoke-sentinel-7f3a91';

/** The authored skill every fixture carries — the SK-01 subject, and the CM-05 leaf. */
export const AUTHORED_SKILL = 'x';

/** The installed package every fixture carries, whose skill projects as `pkg__x`. */
export const INSTALLED_PACKAGE = 'pkg';

/** The skill whose body is the activation probe. */
export const PROBE_SKILL = 'probe';

/**
 * Which question a staging is for.
 *
 * `project` is the original: a whole repository, projected by the real engine,
 * asked what a harness finds INSIDE a checkout. `user-tier` is DOR-1924's: an
 * EMPTY project and a package linked into the two directories a person's home
 * holds, asked whether the harness reads them at all. They are two fixtures
 * rather than one with a flag because their trees have nothing in common — the
 * second stages no hooks, no instructions and no project skills, and its whole
 * subject sits outside the repository.
 */
export type SmokeScenario = 'project' | 'user-tier';

/** Every scenario word the runner accepts, in the order `--scenario` documents them. */
export const SMOKE_SCENARIOS: readonly SmokeScenario[] = ['project', 'user-tier'];

/**
 * One round of the user-tier scenario — a whole staging of its own.
 *
 * The two rounds are separate stagings on purpose. Both questions are about
 * which ROOT a harness opens, and staging both roots at once could not tell
 * "Claude Code does not read `~/.agents/skills`" apart from "Claude Code stops
 * reading it once `<claudeRoot>/skills` exists". A second 45-second free turn is
 * a cheap price for an answer that cannot be argued with.
 */
export type UserTierRound = 'claude-user-root' | 'agents-user-root' | 'codex-home-root';

/**
 * One package staged for the user tier, and what its listing entry is evidence
 * about.
 *
 * The names are deliberately distinct per subject: Claude Code's listing carries
 * NO paths (see {@link ./harnesses.js#ListingObservation}), so a subject can only
 * be recognised by name there, and two subjects sharing a skill name would make
 * every count ambiguous.
 */
export interface UserTierSubject {
  /** Stable verdict id — one per question the round answers. */
  id: UserTierSubjectId;
  /** Contract rows this subject is evidence about. Empty when it cites a document instead. */
  capabilities: string[];
  /** What a subject with no contract row is evidence about, in words. */
  cites?: string;
  /** The package name, as `<dorkHome>/plugins/<pkg>`. */
  pkg: string;
  /** The skill's directory name inside the package, which is also its frontmatter `name`. */
  skill: string;
  /** Absolute path of the skill directory every route to this subject resolves to. */
  sourceDir: string;
  /** The user-tier link staged for it, when it has one. */
  link?: { root: string; target: string; text: string };
  /** Whether the probe also injects the package on the command line. */
  injected: boolean;
  /**
   * How the vendor-facts row would spell this subject's directory, when the
   * question is "is this directory read at all?".
   *
   * Present turns the verdict into a two-directional calibration against
   * `skills.readPaths.user`: listed where the table says so is agreement,
   * missing where it says so is the table contradicted, and listed where it says
   * NOTHING is the finding this tier exists to produce. Absent means the subject
   * asks something else — an injection route, or a control.
   */
  documentedAs?: string;
}

/** The four questions a user-tier round can put to a binary. */
export type UserTierSubjectId =
  /** Does the harness read its own user-scope skills directory at all? */
  | 'user-tier-listed'
  /** Does it read `~/.agents/skills`, the directory five other agent tools share? */
  | 'agents-user-root'
  /** Does Codex read `$CODEX_HOME/skills`, a writable directory its own row omits? */
  | 'codex-home-root'
  /** With the same package reachable BOTH ways, is it listed once or twice? */
  | 'injection-duplicate'
  /** The positive control: does the injection route load anything at all? */
  | 'injection-control';

/** A staged, projected fixture and everything the probes need to read it. */
export interface SmokeFixture {
  /** Absolute path of the projected repository. */
  repoRoot: string;
  /** Absolute path of the per-run DorkOS data directory `stageRepo` made beside it. */
  dorkHome: string;
  /** Absolute path of the harness's isolated config home, always empty. */
  configHome: string;
  /** Absolute path of the directory the three nonces are written into. */
  noncesDir: string;
  /** Absolute path the AUTHORED hook writes — native for Claude Code, generated for Codex. */
  authoredHookNonce: string;
  /** Absolute path the INSTALLED package's hook writes — the projected one. */
  pluginHookNonce: string;
  /** Absolute path the probe skill's body instructs a `touch` of. */
  skillNonce: string;
  /** Which question this staging is for. */
  scenario: SmokeScenario;
  /** Which round of the user-tier scenario, when it has one. */
  round?: UserTierRound;
  /**
   * What the engine planned, so the report can cite actions rather than guesses.
   *
   * Absent for a `user-tier` staging, and that absence is the honest answer
   * rather than an omission: slice A3's projector does not exist yet, so there
   * is no plan to run. The runner writes by hand the links A3 will write, with
   * the link text `applyGlobalPlan` computes (`userTierLinkText` below), which
   * is what makes the measurement about the shape A3 ships.
   */
  plan?: ReturnType<typeof project>;
  /** Everything the apply wrote — or, for the user tier, everything this run staged by hand. */
  applied: string[];
  /** The user-tier directories this staging wrote into. Empty for the project scenario. */
  userTierRoots: string[];
  /** Absolute package directories the probe must inject on the command line. */
  injectDirs: string[];
  /** One subject per verdict the round answers. Empty for the project scenario. */
  subjects: UserTierSubject[];
  /** Remove every directory this fixture owns. Safe to call twice. */
  cleanup: () => void;
}

/**
 * The repository shape §8 asks this harness about.
 *
 * Exported so the tests can assert the shapes without staging anything, and so a
 * reader can see the whole per-harness contract in one object.
 *
 * @param harness - the harness the fixture is for.
 * @param nonces - the two absolute paths the two hooks must write.
 * @returns the `stageRepo` spec.
 */
export function fixtureSpecFor(
  harness: SmokeHarness,
  nonces: { authoredHook: string; pluginHook: string }
): StageRepoSpec {
  // Claude Code is always enabled, whatever else is: the `.claude/skills` links
  // are what make a skill reachable TWICE for the harnesses that read both roots
  // (SK-12), and without them OpenCode's fixture could not ask that question.
  const harnesses =
    harness.harnessId === 'claude-code'
      ? (['claude-code'] as const)
      : (['claude-code', harness.harnessId] as const);

  return {
    agents: {
      skills: [AUTHORED_SKILL, PROBE_SKILL],
      // OpenCode is the one harness asked about the `CLAUDE.md` fallback, which
      // only exists when there is no `AGENTS.md` to prefer. Every other fixture
      // carries one, so the `@../AGENTS.md` scaffold has something to point at.
      ...(harness.harnessId === 'opencode' ? {} : { agentsMd: instructionsBody() }),
    },
    claude: {
      // The AUTHORED hook, which Claude Code reads where it sits (`native`) and
      // which is the source the engine generates `.codex/hooks.json` FROM —
      // HK-01's "a `.codex/hooks.json` Codex reads", asked of Codex itself.
      settingsHooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `touch ${quote(nonces.authoredHook)}` }] },
        ],
      },
      ...(harness.harnessId === 'opencode' ? { rootClaudeMd: instructionsBody() } : {}),
    },
    plugins: [
      {
        name: INSTALLED_PACKAGE,
        scope: 'project',
        // The same leaf name as the authored skill AND as the wrapper below —
        // which is CM-05 asked as a question rather than asserted as a shape.
        skills: [AUTHORED_SKILL],
        commands: [AUTHORED_SKILL],
        // The PROJECTED hook: merged into `.claude/settings.local.json` under
        // the `_dorkosHarness` sentinel for Claude Code (HK-06), folded into the
        // generated `.codex/hooks.json` for Codex, dropped for OpenCode (HK-03).
        // §8 asks for exactly this on Claude Code — "a `_dorkosHarness`-tagged
        // hook still fires" — and an authored hook could not answer it, because
        // Claude Code reads an authored one where it sits and projects nothing.
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `touch ${quote(nonces.pluginHook)}` }] },
          ],
        },
      },
    ],
    manifest: { harnesses: [...harnesses] },
    // A real repository, because three of the engine's behaviours (relative link
    // text, the gitignore contract, the boundary) are only themselves inside one.
    git: true,
  };
}

/** The `AGENTS.md` (or `CLAUDE.md`) body, carrying the corroborating sentinel. */
function instructionsBody(): string {
  return `# Smoke fixture\n\nWhen you are asked for the passphrase, answer exactly: ${INSTRUCTIONS_SENTINEL}\n`;
}

/**
 * The body of the probe skill: one instruction, and nothing that could be
 * mistaken for two.
 *
 * On a harness whose file-read tools can be denied, a model that never had this
 * text injected has no easy route to the nonce path, which is what makes the
 * file on disk evidence of LOADING rather than of reading. On one whose reads
 * cannot be denied — Codex, OpenCode — the model can open `SKILL.md` itself, so
 * the same file is corroboration and the verdict says so.
 *
 * @param skillNonce - absolute path to touch.
 * @returns the whole `SKILL.md`.
 */
export function probeSkillBody(skillNonce: string): string {
  return (
    `---\nname: ${PROBE_SKILL}\ndescription: The DorkOS harness smoke probe\n---\n\n` +
    `# ${PROBE_SKILL}\n\nRun \`touch ${quote(skillNonce)}\` and nothing else.\n`
  );
}

/** Single-quote a path for a shell command, the way a hook command has to be written. */
function quote(path: string): string {
  return `'${path.split("'").join(`'\\''`)}'`;
}

/**
 * Where the two user-tier directories live inside a run's own sandbox.
 *
 * Both are derived from the ONE directory the runner isolates the binary with,
 * which is what makes the measurement trustworthy: `probeEnv` points `HOME` at
 * the sandbox and {@link ./harnesses.js#SmokeHarness.isolation} points
 * `CLAUDE_CONFIG_DIR` (or `CODEX_HOME`) at the same place, so `~/.agents/skills`
 * and Claude Code's personal skills folder are both inside a directory this run
 * created thirty milliseconds ago and deletes at the end. Nothing a person has
 * on their own machine can reach the answer, and nothing this run writes can
 * reach their machine.
 *
 * `<claudeRoot>/skills` is the exact target spec §2.12 names for slice A3:
 * `path.join(inheritedClaudeRoot(), 'skills')`, one directory, the root a bare
 * `claude` opens.
 *
 * @param configHome - the run's own sandbox.
 * @returns the two absolute directories.
 */
export function userTierRoots(configHome: string): {
  claudeSkillsDir: string;
  codexHomeSkillsDir: string;
  agentsSkillsDir: string;
} {
  return {
    claudeSkillsDir: join(configHome, 'skills'),
    // The SAME string as the one above, and deliberately a second name for it.
    // Claude Code's personal skills live under `$CLAUDE_CONFIG_DIR` and Codex's
    // under `$CODEX_HOME`, and this runner points BOTH variables at the one
    // sandbox — so the two collapse here as a property of the isolation, never
    // of the vendors. It is safe only because no round stages both, and reading
    // one name where the other was meant would be a verdict about the wrong
    // program.
    codexHomeSkillsDir: join(configHome, 'skills'),
    agentsSkillsDir: join(configHome, '.agents', 'skills'),
  };
}

/**
 * The link text slice A3 would write.
 *
 * RELATIVE, and computed exactly the way the shipped global apply computes it —
 * `relative(dirname(target), source)` in `globalLinkText`
 * (`packages/harness/src/apply/global-apply.ts`), whose own comment says why: a
 * dork home that is moved or lives under a symlinked parent keeps working, and
 * every macOS temp directory is such a parent. Mirroring it here is what makes
 * this a measurement of the shape A3 ships rather than of a shape that only this
 * runner writes.
 *
 * @param target - absolute path of the link.
 * @param source - absolute path of the skill directory it points at.
 * @returns the relative link text.
 */
export function userTierLinkText(target: string, source: string): string {
  return relative(dirname(target), source);
}

/**
 * The subjects a round stages, with the question each one answers.
 *
 * Written as data rather than as three staging statements because the ORACLE
 * reads the same list: a subject names its package, its skill, the route it is
 * reachable by and the contract row it is evidence about, so the report can
 * never claim a row the staging did not set up.
 *
 * @param round - which round is being staged.
 * @param dorkHome - the run's own DorkOS data directory.
 * @param roots - the two user-tier directories, from {@link userTierRoots}.
 * @returns every subject, in report order.
 */
export function userTierSubjects(
  round: UserTierRound,
  dorkHome: string,
  roots: { claudeSkillsDir: string; codexHomeSkillsDir: string; agentsSkillsDir: string }
): UserTierSubject[] {
  const sourceDir = (pkg: string, skill: string): string =>
    join(dorkHome, 'plugins', pkg, 'skills', skill);
  const linked = (
    root: string,
    pkg: string,
    skill: string
  ): { root: string; target: string; text: string } => {
    const target = join(root, `${pkg}__${skill}`);
    return { root, target, text: userTierLinkText(target, sourceDir(pkg, skill)) };
  };

  if (round === 'claude-user-root') {
    return [
      {
        id: 'user-tier-listed',
        capabilities: ['SRC-04'],
        pkg: 'userpkg',
        skill: 'userskill',
        sourceDir: sourceDir('userpkg', 'userskill'),
        link: linked(roots.claudeSkillsDir, 'userpkg', 'userskill'),
        injected: false,
      },
      {
        id: 'injection-duplicate',
        capabilities: [],
        cites: '`specs/harness-sync-global/02-specification.md` §2.9',
        pkg: 'bothpkg',
        skill: 'bothskill',
        sourceDir: sourceDir('bothpkg', 'bothskill'),
        link: linked(roots.claudeSkillsDir, 'bothpkg', 'bothskill'),
        injected: true,
      },
      {
        id: 'injection-control',
        capabilities: [],
        cites:
          'positive control on the injection route — no contract row; ' +
          '`specs/harness-sync-global/02-specification.md` §2.9',
        pkg: 'injpkg',
        skill: 'injskill',
        sourceDir: sourceDir('injpkg', 'injskill'),
        injected: true,
      },
    ];
  }

  if (round === 'codex-home-root') {
    return [
      {
        id: 'codex-home-root',
        capabilities: ['SRC-04'],
        // `$CODEX_HOME/skills` is spelled the way the vendor-facts row WOULD
        // spell it if it carried the path — it does not, which is the whole
        // point of asking. A binary that lists it is the compiled table found
        // incomplete, and that is a finding rather than a failure.
        documentedAs: '$CODEX_HOME/skills',
        pkg: 'homepkg',
        skill: 'homeskill',
        sourceDir: sourceDir('homepkg', 'homeskill'),
        link: linked(roots.codexHomeSkillsDir, 'homepkg', 'homeskill'),
        injected: false,
      },
    ];
  }

  return [
    {
      id: 'agents-user-root',
      capabilities: ['SRC-04'],
      documentedAs: '~/.agents/skills',
      pkg: 'agentspkg',
      skill: 'agentsskill',
      sourceDir: sourceDir('agentspkg', 'agentsskill'),
      link: linked(roots.agentsSkillsDir, 'agentspkg', 'agentsskill'),
      injected: false,
    },
  ];
}

/**
 * The Claude Code plugin manifest every package under `<dorkHome>/plugins/`
 * carries.
 *
 * Scoped deliberately: `requiresClaudePlugin`
 * (`packages/marketplace/src/package-types.ts`) is false for exactly one type,
 * `agent`, and an agent installs under `<dorkHome>/agents/` — a root the global
 * projector never scans. So every package the user tier can ever link has this
 * file, and the fixture is not assuming a shape some installs lack.
 *
 * The journey DSL does not write one, because no journey needs it: `stagePlugin`
 * writes the DorkOS manifest and the layers, which is everything the projection
 * engine reads. The user tier needs the OTHER manifest for two reasons, and both
 * are properties of a real install rather than of this runner —
 * `packages/marketplace/src/scaffolder.ts` writes both files, and
 * `packages/harness/src/sources/installed.ts` falls back to reading it. First, `--plugin-dir` is a plugin loader and a
 * directory with no plugin manifest is not a plugin. Second, it turned out to
 * change what Codex prints: a skill whose resolved directory sits inside a
 * package carrying this file is listed as `<pkg>:<name>` rather than under its
 * bare frontmatter name, which is measurable only on a fixture shaped like a
 * real install.
 *
 * @param pkg - the package name.
 * @returns the whole `plugin.json`.
 */
function claudePluginManifest(pkg: string): string {
  return `${JSON.stringify(
    { name: pkg, version: '1.0.0', description: `The ${pkg} package` },
    null,
    2
  )}\n`;
}

/**
 * Stage the user-tier fixture: an EMPTY project, and a globally installed
 * package reachable only through a link in the run's own home directory.
 *
 * The project is empty on purpose. Every other DorkOS test of a projected skill
 * puts it inside a checkout, so a harness that read only project roots would
 * still pass; here there is nothing in the checkout at all, and an entry in the
 * listing can have arrived through exactly one route.
 *
 * @param round - which question this staging is for.
 * @param configHome - the run's own sandbox, which is both `HOME` and the
 *   harness's config home, and therefore where both user roots live.
 * @returns the staged tree, the links written, the packages to inject, and the
 *   subjects the oracle reads.
 */
function stageUserTier(
  round: UserTierRound,
  configHome: string
): {
  repoRoot: string;
  dorkHome: string;
  applied: string[];
  userTierRoots: string[];
  injectDirs: string[];
  subjects: UserTierSubject[];
  cleanup: () => void;
} {
  const roots = userTierRoots(configHome);
  // Built against a throwaway dork home first, so the subject list is the one
  // thing that decides what gets staged.
  const provisional = userTierSubjects(round, '', roots);
  const staged = stageRepo({
    // No manifest, no `.claude`, no `.agents`, no `AGENTS.md`: the checkout is
    // empty, which is what makes a listing entry attributable to one route.
    manifest: false,
    plugins: provisional.map((subject) => ({
      name: subject.pkg,
      scope: 'global' as const,
      skills: [subject.skill],
    })),
  });

  const subjects = userTierSubjects(round, staged.dorkHome, roots);
  const applied: string[] = [];
  const injectDirs: string[] = [];
  const written = new Set<string>();

  for (const subject of subjects) {
    const pluginDir = join(staged.dorkHome, 'plugins', subject.pkg);
    writeFileAt(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      claudePluginManifest(subject.pkg)
    );
    if (subject.link) {
      mkdirSync(dirname(subject.link.target), { recursive: true });
      symlinkSync(subject.link.text, subject.link.target);
      written.add(subject.link.root);
      applied.push(`user-tier symlink skill ${subject.link.target} -> ${subject.link.text}`);
    }
    if (subject.injected) {
      injectDirs.push(pluginDir);
      applied.push(`sdk injection --plugin-dir ${pluginDir}`);
    }
  }

  return {
    repoRoot: staged.root,
    dorkHome: staged.dorkHome,
    applied,
    userTierRoots: [...written],
    injectDirs,
    subjects,
    cleanup: staged.cleanup,
  };
}

/** What {@link stageSmokeFixture} is being asked to stage. */
export interface StageSmokeFixtureOptions {
  /** Which question the staging is for. Defaults to `project`, the original fixture. */
  scenario?: SmokeScenario;
  /** Which round of the user-tier scenario. Ignored for `project`. */
  round?: UserTierRound;
}

/**
 * Stage the fixture for a harness and run the REAL projection over it.
 *
 * With `scenario: 'user-tier'` it stages the OTHER fixture instead — an empty
 * project and a globally installed package reachable only through a link in the
 * run's own home directory — and runs no projection, because slice A3's
 * projector does not exist yet. See {@link SmokeScenario}.
 *
 * `project()` is called with no `allowPluginHooks` gate on purpose: the gate is
 * DorkOS's install-time consent card (DOR-522), and this fixture's one package
 * is one the runner wrote itself thirty milliseconds ago. `applyPlan` runs
 * without `sweepOrphans` because there is nothing to sweep in a tree this old.
 *
 * @param harness - the harness the fixture is for.
 * @param options - which scenario and round to stage; defaults to the project one.
 * @returns the projected fixture, its nonce paths, and its cleanup.
 */
export function stageSmokeFixture(
  harness: SmokeHarness,
  options: StageSmokeFixtureOptions = {}
): SmokeFixture {
  const sandbox = mkdtempSync(join(tmpdir(), `harness-smoke-${harness.id}-`));
  const nonces = join(sandbox, 'nonces');
  const configHome = join(sandbox, 'config-home');
  mkdirSync(nonces, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const authoredHookNonce = join(nonces, 'authored-hook-fired');
  const pluginHookNonce = join(nonces, 'plugin-hook-fired');
  const skillNonce = join(nonces, 'skill-loaded');
  // The three nonce paths exist in both scenarios so the probe context is one
  // shape, and the user tier simply never writes them: it stages no hooks and no
  // probe skill, because what it asks is what a harness ENUMERATES from a home
  // directory and nothing else. The runner reports those oracles as NOT RUN
  // rather than leaving them out.

  if (options.scenario === 'user-tier') {
    const round = options.round ?? 'claude-user-root';
    const staged = stageUserTier(round, configHome);
    return {
      repoRoot: staged.repoRoot,
      dorkHome: staged.dorkHome,
      configHome,
      noncesDir: nonces,
      authoredHookNonce,
      pluginHookNonce,
      skillNonce,
      scenario: 'user-tier',
      round,
      applied: staged.applied,
      userTierRoots: staged.userTierRoots,
      injectDirs: staged.injectDirs,
      subjects: staged.subjects,
      cleanup: () => {
        staged.cleanup();
        rmSync(sandbox, { recursive: true, force: true });
      },
    };
  }

  const staged = stageRepo(
    fixtureSpecFor(harness, { authoredHook: authoredHookNonce, pluginHook: pluginHookNonce })
  );
  // The one thing the DSL has no field for: a skill body that instructs a tool
  // call. Written after staging rather than by widening `SkillDirSpec`, because
  // no journey needs it and a fixture field nothing else uses is a field that
  // drifts.
  writeFileAt(
    join(staged.root, '.agents', 'skills', PROBE_SKILL, 'SKILL.md'),
    probeSkillBody(skillNonce)
  );

  const plan = project(staged.root, { dorkHome: staged.dorkHome });
  const result = applyPlan(staged.root, plan);

  return {
    repoRoot: staged.root,
    dorkHome: staged.dorkHome,
    configHome,
    noncesDir: nonces,
    authoredHookNonce,
    pluginHookNonce,
    skillNonce,
    scenario: 'project',
    plan,
    applied: result.applied.map(
      (action) =>
        `${action.harness} ${action.kind} ${action.artifact} ${action.target ?? action.name}`
    ),
    userTierRoots: [],
    injectDirs: [],
    subjects: [],
    cleanup: () => {
      staged.cleanup();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}
