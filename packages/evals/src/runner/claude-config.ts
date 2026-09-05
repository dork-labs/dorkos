/**
 * The controlled `CLAUDE_CONFIG_DIR` a credentialed eval turn runs under.
 *
 * `sandbox.ts` isolates DorkOS's own state (`DORK_HOME`) and the project `cwd`.
 * Neither of those is where a Claude Code turn gets its BEHAVIOR from. The
 * claude-code adapter launches with `settingSources: ['local', 'project',
 * 'user']`, and `'user'` resolves under `$CLAUDE_CONFIG_DIR ?? ~/.claude`
 * (`apps/server/.../claude-code/claude-config-dir.ts`) — so an eval booted on a
 * developer's machine carried that developer's user-level `settings.json`,
 * `CLAUDE.md`, skills, agents, commands and plugins into every measured turn.
 *
 * That is a confound, not a nuisance. A pass rate measured under one person's
 * `~/.claude` does not reproduce on another machine or in CI, and it is not a
 * fact about the product. One observed failure had the model reasoning about a
 * SessionStart hook from an unrelated user plugin instead of answering the
 * prompt at all (DOR-1712). Within-machine differentials (a mutation drill:
 * same machine, one variable changed) stay valid either way; ABSOLUTE numbers
 * measured under an inherited config are machine-relative and must be labelled
 * as such.
 *
 * ## Why this cannot simply always be pinned
 *
 * A Claude config dir is not only behavior — it is also an IDENTITY. Claude Code
 * names its macOS Keychain entry after a hash of the config directory, so a
 * fresh directory is a directory nobody has signed into. Pinning it
 * unconditionally would therefore sign a local run OUT, and the local
 * `claude auth login` sign-in is the third and most-used rung of the runner's
 * documented credential ladder (`credentials.ts`) — the entire reason
 * `pnpm evals:local` needs no setup.
 *
 * So the pin is applied exactly when the run can still authenticate without the
 * operator's real config dir, which is two cases and only two:
 *
 * 1. **A portable credential** (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`).
 *    The credential is a value in the environment, so the config dir carries no
 *    auth weight at all and a clean one costs nothing. This is what CI runs, and
 *    it is the configuration a reproducible baseline must be measured under.
 * 2. **A file-shaped local sign-in.** Where there is no OS keychain, `claude auth
 *    login` writes {@link CLAUDE_CREDENTIALS_FILE} inside its config dir, and
 *    that one file can be carried into the controlled dir without carrying any
 *    of the behavior beside it.
 *
 * When neither holds — a macOS machine whose sign-in lives in the Keychain, with
 * no key or token set — the harness DECLINES to pin and says so
 * ({@link inheritedClaudeConfigNotice}). Refusing to run instead would break the
 * documented local path on the machine it exists for; pinning anyway would break
 * the sign-in. Saying it out loud is the honest third answer: the run proceeds,
 * and its absolute numbers are known to be machine-relative.
 *
 * @module evals/runner/claude-config
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Name of the controlled Claude config directory inside a sandbox root, beside
 * `.dork` and `project`. It lives in the sandbox so it is created, retained and
 * swept by exactly the machinery that already owns the rest of the sandbox.
 */
const SANDBOX_CLAUDE_CONFIG_DIRNAME = '.claude';

/**
 * The file `claude auth login` writes inside its config dir on a machine with no
 * OS keychain. Its presence is what makes a local sign-in CARRYABLE into a
 * controlled config dir; its absence is what makes a keychain sign-in not.
 */
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

/** The variable the Claude Agent SDK subprocess resolves its config dir from. */
const CLAUDE_CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';

/**
 * `settings.json`, written EMPTY rather than left absent. Absent and `{}` behave
 * the same, but an empty file makes the intent legible in a retained sandbox: no
 * hooks, no statusline, no `env` block, no permission rules — this run's settings
 * are nobody's.
 *
 * What is NOT written beside it is the point of the module: no `CLAUDE.md`, no
 * `settings.local.json`, no `skills/`, `agents/`, `commands/` or `plugins/`.
 */
const EMPTY_SETTINGS = '{}\n';

/**
 * Directories created inside the controlled config dir. `projects/` is where the
 * SDK subprocess writes this run's transcripts, and its presence is also what
 * makes the directory qualify as an account root for the server's own structural
 * check (`isClaudeAccountRoot`).
 */
const SEED_DIRS: readonly string[] = ['projects'];

/**
 * `.claude.json` — the state file that answers the TWO first-run gates a config
 * directory nothing has ever run in would otherwise trip. Both key names were
 * read out of the shipped `@anthropic-ai/claude-agent-sdk` 0.3.224 binary, and
 * both are compared `=== true`:
 *
 * 1. `hasCompletedOnboarding` — the global "has this install been set up" gate.
 * 2. `projects[<cwd>].hasTrustDialogAccepted` — the per-directory trust gate, and
 *    the one that actually bites here. It is keyed by PROJECT PATH, and an eval's
 *    cwd is a fresh `mkdtemp` that appears in nobody's map, so every sandbox is a
 *    never-before-seen folder by construction. Seeding the operator's real
 *    `~/.claude.json` never covered this either; isolating the config dir just
 *    makes it unmissable.
 *
 * This is a fresh-directory guard rather than a measured behavior, so it is not
 * proof — the credentialed re-baseline (DOR-1712's second acceptance criterion)
 * is what confirms it. If a turn there dies before it starts, grep the retained
 * server log for `This workspace has not been trusted`: that string is the trust
 * gate refusing, and it means this seed is wrong or its shape has moved.
 *
 * @param projectCwd - The sandbox project directory turns are driven in.
 * @returns The file contents.
 */
function firstRunState(projectCwd: string): string {
  return `${JSON.stringify(
    {
      hasCompletedOnboarding: true,
      projects: { [projectCwd]: { hasTrustDialogAccepted: true } },
    },
    null,
    2
  )}\n`;
}

/** Injectable seams so the resolvers can be tested without a real home or a real env. */
export interface HostClaudeConfigDeps {
  /** Environment to read {@link CLAUDE_CONFIG_DIR_VAR} from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Home directory. Defaults to the real one. */
  homeDir?: string;
}

/**
 * The Claude config dir THIS MACHINE would use with nothing pinned — the SDK's
 * own chain, `$CLAUDE_CONFIG_DIR` else `~/.claude`.
 *
 * Mirrors `inheritedClaudeRoot()` in the server's `claude-config-dir.ts` on
 * purpose: it is the directory the launched server WOULD have resolved had the
 * harness not pinned one, so it is also the only place a carryable sign-in could
 * be sitting.
 *
 * @param deps - Injectable env + home seams; both default to the real ones.
 * @returns The absolute config directory this machine resolves on its own.
 */
export function resolveHostClaudeConfigDir(deps: HostClaudeConfigDeps = {}): string {
  const env =
    deps.env ??
    // eslint-disable-next-line no-restricted-syntax -- the ambient Claude config dir is a harness/runner input read once here (the harness env carve-out pattern), not an app config value.
    process.env;
  const ambient = env[CLAUDE_CONFIG_DIR_VAR];
  if (ambient && ambient.trim() !== '') return ambient;
  return path.join(deps.homeDir ?? homedir(), '.claude');
}

/** Resolve true iff `p` exists on disk. */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the controlled config dir under `sandboxRoot` and write its seed.
 *
 * Called by `createSandbox()` for every sandbox, whether or not the run ends up
 * pinning it: the directory is a few bytes inside a throwaway root, and having
 * it always present means oracles and a retained sandbox can be read the same
 * way on every tier.
 *
 * @param sandboxRoot - The sandbox root (parent of `.dork` and `project`).
 * @param projectCwd - The sandbox project directory turns are driven in, passed
 *   in rather than re-derived here: the trust gate is keyed by that exact path,
 *   and two modules spelling the sandbox layout independently is how they drift.
 * @returns The absolute path of the seeded config directory.
 */
export async function seedControlledClaudeConfig(
  sandboxRoot: string,
  projectCwd: string
): Promise<string> {
  const dir = path.join(sandboxRoot, SANDBOX_CLAUDE_CONFIG_DIRNAME);
  await mkdir(dir, { recursive: true });
  for (const sub of SEED_DIRS) await mkdir(path.join(dir, sub), { recursive: true });
  await writeFile(path.join(dir, 'settings.json'), EMPTY_SETTINGS, 'utf8');
  await writeFile(path.join(dir, '.claude.json'), firstRunState(projectCwd), 'utf8');
  return dir;
}

/** Whether a run can authenticate without the operator's real Claude config dir. */
export interface CanPinDeps extends HostClaudeConfigDeps {
  /** True when the resolved credential is a value (a key or a token), not a sign-in. */
  credentialIsPortable: boolean;
  /** The host config dir to look for a carryable sign-in in. Defaults to the resolved one. */
  hostConfigDir?: string;
}

/**
 * Whether this run may be pinned to a controlled config dir — i.e. whether it can
 * still reach a model without the operator's real one.
 *
 * A portable credential answers yes without touching the disk. Only a local
 * sign-in has to ask whether it is file-shaped, and that is one `stat`.
 *
 * @param deps - The credential's portability plus the host-dir seams.
 * @returns True when pinning is safe; false when it would sign the run out.
 */
export async function canPinControlledClaudeConfig(deps: CanPinDeps): Promise<boolean> {
  if (deps.credentialIsPortable) return true;
  const hostDir = deps.hostConfigDir ?? resolveHostClaudeConfigDir(deps);
  return exists(path.join(hostDir, CLAUDE_CREDENTIALS_FILE));
}

/** The outcome of asking for a controlled config dir for one eval. */
export type ClaudeConfigPin =
  /** Pin this directory as `CLAUDE_CONFIG_DIR`; the run's user-level config is nobody's. */
  | { pinned: true; configDir: string; carriedSignIn: boolean }
  /**
   * Do not pin. The run inherits the operator's config dir, because that
   * directory IS its sign-in and there is no other way to reach a model.
   */
  | { pinned: false; reason: string };

/** Options for {@link resolveClaudeConfigPin}. */
export interface ResolveClaudeConfigPinOptions extends CanPinDeps {
  /** The sandbox's seeded config dir ({@link seedControlledClaudeConfig}). */
  claudeConfigDir: string;
}

/**
 * Decide whether this eval pins the controlled config dir, and finish provisioning
 * it if so.
 *
 * The sign-in file is copied ONLY when the run actually needs it — a run holding a
 * key or a token never has a credential written into a sandbox that a failed eval
 * may deliberately retain on disk.
 *
 * On the one row that DOES copy one (a file-shaped local sign-in), that copy
 * outlives a failed eval by design, because retention is what makes a red case
 * debuggable. It is a `copyFile`, so it keeps the source's mode — a `0600` sign-in
 * stays `0600` — inside a `mkdtemp` root, which Node creates `0700`. `pnpm
 * evals:sweep` is what removes it afterwards, and it is the reason that command
 * matters here rather than being only a disk-space chore: a sandbox left behind by
 * an interrupted run of THIS row still holds a usable credential.
 *
 * @param opts - The sandbox's config dir plus the credential/host seams.
 * @returns Whether to pin, and the directory to pin.
 */
export async function resolveClaudeConfigPin(
  opts: ResolveClaudeConfigPinOptions
): Promise<ClaudeConfigPin> {
  if (opts.credentialIsPortable) {
    return { pinned: true, configDir: opts.claudeConfigDir, carriedSignIn: false };
  }

  const hostDir = opts.hostConfigDir ?? resolveHostClaudeConfigDir(opts);
  const source = path.join(hostDir, CLAUDE_CREDENTIALS_FILE);
  if (!(await exists(source))) {
    return { pinned: false, reason: inheritedClaudeConfigNotice(hostDir) };
  }
  await copyFile(source, path.join(opts.claudeConfigDir, CLAUDE_CREDENTIALS_FILE));
  return { pinned: true, configDir: opts.claudeConfigDir, carriedSignIn: true };
}

/**
 * What a run is told when its config dir could not be isolated. Says plainly that
 * the numbers are machine-relative, and names the one-line fix, because a
 * confound nobody is told about is the failure this whole module exists to end.
 *
 * It also names what the harness does INSTEAD, because declining the pin has a
 * second consequence the earlier wording never mentioned: the run's home stays
 * the operator's, so the server would otherwise full-text-index their Claude
 * Code, Codex and OpenCode history into a throwaway sandbox (DOR-1779). That is
 * turned off rather than left to happen, and a person reading this deserves to
 * know both halves — what was kept, and what was given up to keep it.
 *
 * @param hostConfigDir - The config dir the run will inherit instead.
 * @returns The notice to print once per run.
 */
export function inheritedClaudeConfigNotice(hostConfigDir: string): string {
  return (
    `This run inherits your own Claude settings from ${hostConfigDir}, so its turns also read ` +
    `your user-level CLAUDE.md, settings and skills. Comparisons within this machine still hold; ` +
    `absolute pass rates will not reproduce elsewhere.\n` +
    `The harness would isolate them, but your sign-in lives in the OS keychain and belongs to that ` +
    `exact directory, so moving it would sign this run out. Because its home stays yours, this ` +
    `run also indexes no conversation history for search — yours or its own — which is how it ` +
    `avoids copying your transcripts into a throwaway sandbox. Set CLAUDE_CODE_OAUTH_TOKEN (from ` +
    `\`claude setup-token\`) or ANTHROPIC_API_KEY to get a clean, reproducible config.`
  );
}
