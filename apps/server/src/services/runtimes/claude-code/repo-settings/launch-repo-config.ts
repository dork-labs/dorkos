/**
 * The launch's half of repo and worktree settings (DOR-3298): outside an
 * agent's own home, what a repo's files would run waits for a person when
 * nobody reviewed it.
 *
 * - **`.claude/settings.local.json`** (gitignored, so never reviewed): when it
 *   adds hooks, helpers, MCP choices, env or allow rules a person has not
 *   approved (by content, `repo-local-settings.ts`), the launch drops the
 *   `local` settings source. The repo's committed settings and `CLAUDE.md`
 *   still load. Fails closed whatever git says.
 * - **Committed hooks** (`.claude/settings.json` code keys, `.claude/hooks/**`
 *   and the repo files hook commands name): when they differ from the default
 *   branch (`repo-baseline.ts`) and that content is not approved, the launch
 *   leaves out the repo's `project` and `local` settings sources: none of the
 *   repo's hooks, code settings (`env`, helpers, plugins), skills, commands or
 *   subagents load. The person's own settings and hooks, and DorkOS's own SDK
 *   hooks, still apply, and the repo's `CLAUDE.md` text is passed in the
 *   system prompt. So does a repo when git isn't installed, or when git puts
 *   the work tree somewhere else. A change to the settings that
 *   pick `.mcp.json` servers also pins MCP as below. Allow rules the default
 *   branch does not have are added to `permissions.ask` at the flag layer, so
 *   those tools go through DorkOS's own permission check (ask beats allow).
 * - **`.mcp.json`**: when it differs from the default branch and that content
 *   is not approved, the launch sets `strictMcpConfig` and passes the default
 *   branch's servers itself, beside DorkOS's own.
 *
 * Each raises a card (`repo-config-approval.ts`) and one names-only Activity
 * line (`repo-config-activity.ts`), and logs a warning. Approval is by content
 * only, so the same change is approved once for every worktree.
 *
 * Skipped for a turn that stands in its agent's registered home itself (not a
 * folder below it, which can hold settings of its own), which the agent-home
 * pin covers (`launch-folder-config.ts`), and for a teammate's turn,
 * which loads no settings source at all. All proven on the real CLI
 * (`repo-config-switches.binary.test.ts`).
 *
 * @module services/runtimes/claude-code/repo-settings/launch-repo-config
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';
import { folderAllowApprovalGateway } from '../folder-settings/folder-allow-approval.js';
import { leaveOutFolderSettings } from '../folder-settings/launch-folder-config.js';
import { notePaused, noteRunning } from './repo-config-activity.js';
import {
  askForRepoConfig,
  mayAskAboutRepoConfig,
  worktreeName,
  type RepoConfigReread,
  type RepoConfigRequest,
} from './repo-config-approval.js';
import {
  isRepoConfigApproved,
  recordedBaseline,
  type RecordedBaseline,
  type RepoConfigKind,
} from './repo-config-consent.js';
import { describeCandidate } from './repo-baseline-move.js';
import { readRepoConfig } from './repo-config-parts.js';
import { resolveRepoBaseline, type RepoBaseline } from './repo-baseline.js';
import { readLocalSettings } from './repo-local-settings.js';

/** Who the turn is for and where it stands. */
export interface RepoConfigTurn {
  /** The agent's name, for the card, if the turn runs as one. */
  agentName: string | undefined;
  /** The registered agent home the turn resolved to, if any. */
  home: string | undefined;
  /** The folder the turn launches in. */
  cwd: string;
  /** A teammate's turn, which loads no settings source. */
  teammate: boolean;
  /** DorkOS's data folder. */
  dorkHome: string;
}

/** What a launch pauses. */
export interface RepoConfigLaunch {
  /** Leave out `.claude/settings.local.json`. */
  dropLocal: boolean;
  /** Turn every repo hook off. */
  pauseHooks: boolean;
  /** Start only DorkOS's servers and these (the default branch's), or `null` to leave MCP alone. */
  mcpServers: Record<string, unknown> | null;
  /** Allow rules nobody reviewed, made to ask instead. */
  askRules: string[];
  /** The repo's top, for the instructions a paused launch still passes; `null` outside one. */
  repoRoot: string | null;
}

/** Nothing paused. */
const NOTHING_PAUSED: RepoConfigLaunch = {
  dropLocal: false,
  pauseHooks: false,
  mcpServers: null,
  askRules: [],
  repoRoot: null,
};

/** Everything paused, for a check that failed. */
const ALL_PAUSED: RepoConfigLaunch = {
  dropLocal: true,
  pauseHooks: true,
  mcpServers: {},
  askRules: [],
  repoRoot: null,
};

/** Whether `cwd` is the home folder itself, by real path. */
async function isHomeItself(cwd: string, home: string): Promise<boolean> {
  const resolve = (p: string) => realpath(path.resolve(p)).catch(() => path.resolve(p));
  const [here, realHome] = await Promise.all([resolve(cwd), resolve(home)]);
  return here === realHome;
}

/**
 * Decide what this launch pauses, and ask a person about anything new. Never
 * throws: a check that fails pauses everything.
 *
 * @param turn - Who the turn is for and where it stands.
 */
export async function resolveRepoConfigForLaunch(turn: RepoConfigTurn): Promise<RepoConfigLaunch> {
  if (turn.teammate) return NOTHING_PAUSED;
  if (turn.home && (await isHomeItself(turn.cwd, turn.home))) return NOTHING_PAUSED;
  try {
    return await checkRepoConfig(turn);
  } catch (err) {
    logger.warn("[RepoConfig] Couldn't check a worktree's repo settings; pausing them", {
      cwd: turn.cwd,
      error: err instanceof Error ? err.message : String(err),
    });
    return ALL_PAUSED;
  }
}

/** What one kind needs: a pause, and maybe a card. */
interface Pause {
  kind: RepoConfigKind;
  digest: string;
  names: string[];
  detail: string;
  approvable: boolean;
  /** What changed, by name, for the Activity line. */
  what: string;
}

/** The check itself; throws on a failure the caller turns into a full pause. */
async function checkRepoConfig(turn: RepoConfigTurn): Promise<RepoConfigLaunch> {
  const { cwd, dorkHome } = turn;
  const wt = worktreeName(cwd);
  const decision: RepoConfigLaunch = { ...NOTHING_PAUSED, askRules: [] };
  const pauses: Pause[] = [];

  const local = readLocalSettings(cwd, dorkHome);
  if (local && !(local.approvable && isRepoConfigApproved('local', local.digest))) {
    decision.dropLocal = true;
    pauses.push({
      kind: 'local',
      digest: local.digest,
      names: local.keys,
      detail: local.detail,
      approvable: local.approvable,
      what: `settings.local.json sets ${local.keys.join(', ')}`,
    });
  } else {
    noteRunning('local', cwd, wt);
  }

  const baseline = await resolveRepoBaseline(cwd, turn.dorkHome);
  decision.repoRoot = baseline.root;
  if (baseline.status === 'no-git') {
    // Nothing to compare the committed settings against: they pause (S1).
    decision.pauseHooks = true;
    decision.mcpServers = {};
  }
  if (baseline.status === 'compared') {
    const reading = await readRepoConfig(cwd, baseline, dorkHome);
    const hooks = reading.hooks;
    if (hooks && !(hooks.approvable && isRepoConfigApproved('hooks', hooks.digest))) {
      decision.pauseHooks = true;
      decision.askRules = hooks.addedAllows;
      if (hooks.mcpKeysChanged) decision.mcpServers = reading.baselineServers;
      pauses.push({
        kind: 'hooks',
        ...hooks,
        names: hooks.files,
        what:
          hooks.files.length === 1
            ? `${hooks.files[0]} changed`
            : `${hooks.files.length} hook files changed`,
      });
    } else {
      noteRunning('hooks', cwd, wt);
    }
    const mcp = reading.mcpJson;
    if (mcp && !(mcp.approvable && isRepoConfigApproved('mcpJson', mcp.digest))) {
      decision.mcpServers = reading.baselineServers;
      pauses.push({
        kind: 'mcpJson',
        ...mcp,
        names: mcp.files,
        what: `${mcp.files.join(', ')} changed`,
      });
    } else if (!decision.mcpServers) {
      noteRunning('mcpJson', cwd, wt);
    }
  }

  // A repo DorkOS can't trust yet gets one card for its default branch, built
  // from that commit; the worktree's own changes are asked about once it is
  // trusted, against it.
  const trustable = isTrustable(baseline);
  for (const pause of pauses) raise(turn, pause, { ask: !trustable || pause.kind === 'local' });
  if (trustable && pauses.some((pause) => pause.kind !== 'local')) {
    void raiseTrust(turn, baseline).catch((err: unknown) => {
      logger.warn("[RepoConfig] Couldn't ask to trust a repo's default branch", {
        cwd: turn.cwd,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return decision;
}

/** Log, write the Activity line, and ask a person when there is something they can approve. */
function raise(turn: RepoConfigTurn, pause: Pause, { ask }: { ask: boolean }): void {
  const { cwd } = turn;
  logger.warn('[RepoConfig] Paused repo settings nobody approved', {
    kind: pause.kind,
    cwd,
    names: pause.names,
    approvable: pause.approvable,
  });
  notePaused(pause.kind, cwd, worktreeName(cwd), pause.what, pause.digest);
  // Content DorkOS can't read is never put to a person: a yes couldn't make it run.
  if (!ask || !pause.approvable) return;
  const gateway = folderAllowApprovalGateway();
  if (!gateway || !mayAskAboutRepoConfig(pause.kind, pause.digest)) return;
  const request: RepoConfigRequest = {
    kind: pause.kind,
    digest: pause.digest,
    names: pause.names,
    detail: pause.detail,
    cwd,
    agentName: turn.agentName,
  };
  void askForRepoConfig(gateway, request, rereadFor(turn, pause.kind), () => {
    void resolveRepoConfigForLaunch(turn);
  }).catch((err: unknown) => {
    logger.warn("[RepoConfig] Couldn't ask about repo settings", {
      kind: pause.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** A repo DorkOS can't trust as it stands, with the commit a yes would record. */
type TrustableBaseline = RepoBaseline & {
  untrusted: 'first-seen' | 'moved' | 'hooks-moved';
  candidate: RecordedBaseline;
  commonDir: string;
};

/** Whether a person's yes could make this baseline trusted. */
function isTrustable(baseline: RepoBaseline): baseline is TrustableBaseline {
  return (
    (baseline.untrusted === 'first-seen' ||
      baseline.untrusted === 'moved' ||
      baseline.untrusted === 'hooks-moved') &&
    baseline.candidate !== undefined &&
    baseline.commonDir !== undefined
  );
}

/**
 * What a trust card shows: the commit a yes records, read from git, never the
 * worktree. A branch that moved forward shows only what changed since the
 * pinned commit; a repo DorkOS never pinned shows everything that runs.
 */
async function candidateFor(baseline: TrustableBaseline, dorkHome: string) {
  const from =
    baseline.untrusted === 'hooks-moved'
      ? (recordedBaseline(baseline.commonDir)?.sha ?? null)
      : null;
  return describeCandidate(baseline.root, from, baseline.candidate.sha, dorkHome);
}

/** Ask a person to trust the repo's default branch, once per commit and content. */
async function raiseTrust(turn: RepoConfigTurn, baseline: TrustableBaseline): Promise<void> {
  const gateway = folderAllowApprovalGateway();
  if (!gateway) return;
  const shown = await candidateFor(baseline, turn.dorkHome);
  if (!mayAskAboutRepoConfig('hooks', shown.digest)) return;
  const request: RepoConfigRequest = {
    kind: 'hooks',
    digest: shown.digest,
    names: shown.files,
    detail: shown.detail,
    cwd: turn.cwd,
    agentName: turn.agentName,
    trust: {
      commonDir: baseline.commonDir,
      baseline: baseline.candidate,
      reason: baseline.untrusted,
    },
  };
  const reread: RepoConfigReread = async () => {
    try {
      const now = await resolveRepoBaseline(turn.cwd, turn.dorkHome);
      if (now.status !== 'compared') return 'unknown';
      if (!now.untrusted) return 'clean';
      return isTrustable(now)
        ? { digest: (await candidateFor(now, turn.dorkHome)).digest }
        : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  await askForRepoConfig(gateway, request, reread, () => {
    void resolveRepoConfigForLaunch(turn);
  });
}

/** Read one kind again, for a card that is open. */
function rereadFor(turn: RepoConfigTurn, kind: RepoConfigKind): RepoConfigReread {
  return async () => {
    try {
      if (kind === 'local') {
        const local = readLocalSettings(turn.cwd, turn.dorkHome);
        return local ? { digest: local.digest } : 'clean';
      }
      const baseline = await resolveRepoBaseline(turn.cwd, turn.dorkHome);
      if (baseline.status !== 'compared') return 'unknown';
      const now = (await readRepoConfig(turn.cwd, baseline, turn.dorkHome))[kind];
      return now ? { digest: now.digest } : 'clean';
    } catch {
      return 'unknown';
    }
  };
}

/**
 * Resolve what a launch's repo settings pause, in DorkOS's data folder, and
 * apply the pauses that are settings: {@link resolveRepoConfigForLaunch} then
 * {@link applyRepoConfigToLaunch}. The answer goes on to
 * {@link applyRepoMcpServers} once the MCP servers are set.
 *
 * @param sdkOptions - The launch options, mutated.
 * @param turn - Who the turn is for and where it stands.
 */
export async function applyRepoConfigStep(
  sdkOptions: Options,
  turn: Omit<RepoConfigTurn, 'dorkHome'>
): Promise<RepoConfigLaunch> {
  const decision = await resolveRepoConfigForLaunch({ ...turn, dorkHome: resolveDorkHome() });
  applyRepoConfigToLaunch(sdkOptions, decision);
  return decision;
}

/**
 * Apply the pauses that are settings: drop the `local` source, turn hooks off,
 * make unreviewed allow rules ask, and pin MCP to what DorkOS passes. Call before the MCP servers are set.
 *
 * @param sdkOptions - The launch options, mutated.
 * @param decision - What {@link resolveRepoConfigForLaunch} paused.
 */
export function applyRepoConfigToLaunch(sdkOptions: Options, decision: RepoConfigLaunch): void {
  if (decision.dropLocal && sdkOptions.settingSources) {
    sdkOptions.settingSources = sdkOptions.settingSources.filter((source) => source !== 'local');
  }
  if (decision.pauseHooks || decision.askRules.length > 0) {
    const base = (
      typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
        ? sdkOptions.settings
        : {}
    ) as { permissions?: { ask?: string[] } };
    const next: Record<string, unknown> = { ...base };
    if (decision.askRules.length > 0) {
      next.permissions = {
        ...base.permissions,
        ask: [...(base.permissions?.ask ?? []), ...decision.askRules],
      };
    }
    sdkOptions.settings = next as Options['settings'];
  }
  if (decision.mcpServers) sdkOptions.strictMcpConfig = true;
  // Paused: leave out the repo's own settings sources, which is what stops a
  // changed `env`, helper command, plugin or skill as well as its hooks, while
  // the person's own settings and hooks still apply (DOR-3298 M5).
  if (decision.pauseHooks) {
    leaveOutFolderSettings(sdkOptions, decision.repoRoot ?? sdkOptions.cwd ?? '.');
  }
}

/**
 * Pass the default branch's MCP servers beside DorkOS's own when MCP is
 * pinned. DorkOS's win a name clash; none of them is ever dropped. Call after
 * the launch's own MCP servers are set.
 *
 * `${VAR}` and `${VAR:-default}` in a server's strings are filled from the
 * launch's environment, as Claude Code does for a `.mcp.json`.
 *
 * @param sdkOptions - The launch options, mutated.
 * @param decision - What {@link resolveRepoConfigForLaunch} paused.
 */
export function applyRepoMcpServers(sdkOptions: Options, decision: RepoConfigLaunch): void {
  if (!decision.mcpServers) return;
  const env = (sdkOptions.env ?? {}) as Record<string, string | undefined>;
  const repo = expandVariables(decision.mcpServers, env) as Record<string, McpServerConfig>;
  sdkOptions.mcpServers = { ...repo, ...(sdkOptions.mcpServers ?? {}) };
}

/** `${VAR}` and `${VAR:-default}` in every string under `value`. */
function expandVariables(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback: string | undefined) => env[name] ?? fallback ?? ''
    );
  }
  if (Array.isArray(value)) return value.map((item) => expandVariables(item, env));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, expandVariables(child, env)])
  );
}
