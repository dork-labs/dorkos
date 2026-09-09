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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** What the engine planned, so the report can cite actions rather than guesses. */
  plan: ReturnType<typeof project>;
  /** Everything the apply wrote, in the engine's own words. */
  applied: string[];
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
 * Stage the fixture for a harness and run the REAL projection over it.
 *
 * `project()` is called with no `allowPluginHooks` gate on purpose: the gate is
 * DorkOS's install-time consent card (DOR-522), and this fixture's one package
 * is one the runner wrote itself thirty milliseconds ago. `applyPlan` runs
 * without `sweepOrphans` because there is nothing to sweep in a tree this old.
 *
 * @param harness - the harness the fixture is for.
 * @returns the projected fixture, its nonce paths, and its cleanup.
 */
export function stageSmokeFixture(harness: SmokeHarness): SmokeFixture {
  const sandbox = mkdtempSync(join(tmpdir(), `harness-smoke-${harness.id}-`));
  const nonces = join(sandbox, 'nonces');
  const configHome = join(sandbox, 'config-home');
  mkdirSync(nonces, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const authoredHookNonce = join(nonces, 'authored-hook-fired');
  const pluginHookNonce = join(nonces, 'plugin-hook-fired');
  const skillNonce = join(nonces, 'skill-loaded');

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
    plan,
    applied: result.applied.map(
      (action) =>
        `${action.harness} ${action.kind} ${action.artifact} ${action.target ?? action.name}`
    ),
    cleanup: () => {
      staged.cleanup();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}
