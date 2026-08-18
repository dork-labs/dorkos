import { Router, type Request, type Response } from 'express';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { resolveClaudeCliPath } from '../services/runtimes/claude-code/sdk/sdk-utils.js';
import { describeClaudeCodeAccounts } from '../services/runtimes/claude-code/claude-config-dir.js';
import { configManager } from '../services/core/config-manager.js';
// Straight from the module, not the `services/session` barrel: that barrel pulls
// in the projector, transcript readers, and the turn trigger, none of which a
// config GET needs to load.
import { describeExecutionDefaults } from '../services/session/resolve-session-defaults.js';
// The route is where the registry and the resolver meet. `resolve-session-defaults`
// cannot reach the registry itself — the registry imports IT — so the caller
// hands over the capability map instead of the module reaching for it.
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { env } from '../env.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import {
  SIDEBAR_PREFS_DEFAULTS,
  SHAPE_USER_PREFS_DEFAULTS,
  STATUS_BAR_PREFS_DEFAULTS,
  COMPOSER_PREFS_DEFAULTS,
  USER_CONFIG_DEFAULTS,
  USER_PROFILE_DEFAULTS,
} from '@dorkos/shared/config-schema';
import { describeExperiments } from '../services/core/config/describe-experiments.js';
import { deepMerge } from '../services/core/operator/config-patch.js';
import {
  applyGuardedConfigWrite,
  logConfigWrite,
  type ConfigWriteAuthority,
} from '../services/core/operator/config-write.js';
import {
  describeOperatorOnlyRefusal,
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
  REQUIRES_LOGIN_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
  requireStandingGrantsLogin,
} from '../lib/caller-authority.js';
import {
  readStandingGrantPosture,
  revokeStandingGrantsIfPostureNarrowed,
} from '../services/core/approvals/index.js';
import { getLatestVersion } from '../services/core/update-checker.js';
import { isTasksEnabled, getTasksInitError } from '../services/tasks/task-state.js';
import { isRelayEnabled, getRelayInitError } from '../services/relay/relay-state.js';
import { getMeshInitError } from '../services/mesh/mesh-state.js';
import { getBoundary } from '../lib/boundary.js';
import { SERVER_VERSION, IS_DEV_BUILD } from '../lib/version.js';
import { logger, logError } from '../lib/logger.js';
import { hasAnyApiKey } from '../services/core/auth/index.js';
import { getMcpLocalToken, rotateMcpLocalToken } from '../services/core/auth/mcp-local-token.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { resolveAgentsDirectory } from '../lib/agents-home.js';

const router = Router();

// Re-exported from the shared config-patch service (the SSOT for merge + patch
// semantics) so existing importers — and the `deepMerge` unit test — keep their
// `routes/config.js` import path.
export { deepMerge };

/**
 * Whether an environment variable, rather than the user's setting, decides
 * whether the Tasks scheduler runs.
 *
 * `index.ts` gates the subsystem on `DORKOS_TASKS_ENABLED` when that variable is
 * PRESENT and falls back to `scheduler.enabled` when it is not, so presence — not
 * value — is the question. Read once at module load: the server's environment
 * does not change while it runs, and a per-request read would just repeat it.
 */
// eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
const TASKS_LOCKED_BY_ENV = 'DORKOS_TASKS_ENABLED' in process.env;

/** The same question for the Relay message bus and `DORKOS_RELAY_ENABLED`. */
// eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
const RELAY_LOCKED_BY_ENV = 'DORKOS_RELAY_ENABLED' in process.env;

/**
 * List the agent runtimes configured on this host.
 *
 * claude-code is always available; codex and opencode are included unless a user
 * has explicitly disabled them in config (both default to enabled).
 */
function configuredRuntimes(): string[] {
  const runtimes = ['claude-code'];
  const config = configManager.get('runtimes');
  if (config?.codex?.enabled !== false) runtimes.push('codex');
  if (config?.opencode?.enabled !== false) runtimes.push('opencode');
  return runtimes;
}

router.get('/', async (_req, res) => {
  let claudeCliPath: string | null = null;
  try {
    claudeCliPath = resolveClaudeCliPath() ?? null;
  } catch {
    // CLI path resolution can fail — fallback to null
  }

  const tunnel = tunnelManager.status;
  const latestVersion = await getLatestVersion();

  res.json({
    version: SERVER_VERSION,
    latestVersion,
    isDevMode: IS_DEV_BUILD,
    dismissedUpgradeVersions:
      (configManager.get('ui') as { dismissedUpgradeVersions?: string[] } | undefined)
        ?.dismissedUpgradeVersions ?? [],
    port: env.DORKOS_PORT,
    uptime: process.uptime(),
    // The resolved default working directory (lib/resolve-root.js) — the same
    // value `GET /api/directory/default` reports, and for the same reason: a
    // Finder-launched Mac app runs with `process.cwd()` at `/`, which every
    // boundary-enforced route then refuses (DOR-1334 / F11). Resolved, not
    // clamped: `DORKOS_DEFAULT_CWD` is validated against the boundary by
    // whoever sets it (the CLI does; the desktop shell will).
    workingDirectory: DEFAULT_CWD,
    platform: `${process.platform}-${process.arch}`,
    runtimes: configuredRuntimes(),
    // Which Claude account new work will run and bill on, RESOLVED, plus the
    // accounts registered here (spec claude-code-accounts). Resolved for the same
    // reason `claudeCliPath` is: the cockpit cannot see the server process's
    // `CLAUDE_CONFIG_DIR`, so it would otherwise show an empty field where the
    // effective default belongs. The reader falls back to the section defaults on
    // its own, which covers the pre-migration read window.
    claudeCode: describeClaudeCodeAccounts(),
    // What a new session starts with — the runtime, and the model and effort per
    // runtime. Writable through PATCH already; this is the read the Defaults card
    // needs, because a curated view is the only config the cockpit ever sees.
    executionDefaults: describeExecutionDefaults(runtimeRegistry.getAllCapabilities()),
    boundary: getBoundary(),
    // Set by index.ts at startup before routes are registered — always present at request time
    dorkHome: process.env.DORK_HOME!,
    nodeVersion: process.version,
    claudeCliPath,
    tunnel: {
      ...tunnel,
      authEnabled: tunnel.authEnabled || !!env.TUNNEL_AUTH,
      tokenConfigured:
        tunnel.tokenConfigured || !!(env.NGROK_AUTHTOKEN || configManager.get('tunnel')?.authtoken),
    },
    // `enabled` is what is RUNNING; `enabledInConfig` is what the setting says.
    // They are two different facts because `index.ts` reads these flags once, at
    // boot, so a setting changed while the server is up does not move `enabled`
    // until the next start. A settings screen that showed only `enabled` would
    // appear to discard the change; one that showed only the setting would claim
    // an effect it has not had. Both go out, and the cockpit says which is which.
    tasks: {
      enabled: isTasksEnabled(),
      enabledInConfig: configManager.get('scheduler')?.enabled ?? true,
      lockedByEnv: TASKS_LOCKED_BY_ENV,
      ...(getTasksInitError() && { initError: getTasksInitError() }),
    },
    relay: {
      enabled: isRelayEnabled(),
      enabledInConfig: configManager.get('relay')?.enabled ?? true,
      lockedByEnv: RELAY_LOCKED_BY_ENV,
      ...(getRelayInitError() && { initError: getRelayInitError() }),
    },
    scheduler: configManager.get('scheduler') ?? {
      maxConcurrentRuns: 1,
      timezone: null,
      retentionCount: 100,
    },
    logging: configManager.get('logging') ?? {
      level: 'info',
      maxLogSizeKb: 500,
      maxLogFiles: 14,
    },
    mesh: {
      enabled: true,
      scanRoots: configManager.get('mesh')?.scanRoots ?? [],
      ...(getMeshInitError() && { initError: getMeshInitError() }),
    },
    // Sent whole. A block written before a field existed still reads back with
    // that field — `ConfigManager` loads through the schema, so every leaf
    // arrives filled from its default — which is what lets the wire contract
    // promise `string | null` for timestamps nobody has ever written. Per-field
    // `?? null` normalization here would be dead code; the guarantee is pinned
    // by an upgrade-path test in `__tests__/config.test.ts` rather than
    // re-asserted per field. The fallback covers only a config with no
    // `onboarding` block at all.
    onboarding: configManager.get('onboarding') ?? {
      completedSteps: [],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
      completedAt: null,
      runtimeDefaultSetAt: null,
    },
    tours: configManager.get('tours') ?? { seen: [], declined: [] },
    // Who the user is, in their own words (spec user-profile-onboarding).
    // Local-only; the fallback covers the pre-migration read window.
    profile: configManager.get('profile') ?? USER_PROFILE_DEFAULTS,
    agentContext: configManager.get('agentContext') ?? {
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    },
    // `defaultDirectory` goes out RESOLVED: the cockpit shows a person where a
    // new agent will live and probes that path for a `.dork` conflict, so it has
    // to be the directory the server will actually use. The stored value is the
    // portable `~/.dork/agents` spelling, which is not the data directory once
    // `DORK_HOME` is redirected (DOR-662).
    agents: (() => {
      const agents = configManager.get('agents') ?? USER_CONFIG_DEFAULTS.agents;
      return { ...agents, defaultDirectory: resolveAgentsDirectory(agents.defaultDirectory) };
    })(),
    mcp: (() => {
      const mcpConfig = configManager.get('mcp');
      // Trim-for-presence: a whitespace-only MCP_API_KEY counts as unset,
      // matching the boot wiring, the token module, and the auth middleware.
      const envKey = env.MCP_API_KEY?.trim() || null;
      const legacyKey = mcpConfig?.apiKey ?? null;
      const localToken = getMcpLocalToken();
      // authSource reports how MCP access is secured:
      //   'env'         — the static MCP_API_KEY override (headless deployments).
      //   'user-keys'   — per-user Better Auth API keys (the current model), or a
      //                   not-yet-seeded legacy config key on its way to becoming one.
      //   'local-token' — login off, no MCP_API_KEY: the per-instance local token
      //                   gates the mutating surface (DOR-278). The surface is
      //                   still gated, so authConfigured is true.
      //   'none'        — the degenerate can't-generate fallback (should not occur
      //                   in a normal login-off boot).
      const authSource: 'env' | 'user-keys' | 'none' | 'local-token' = envKey
        ? 'env'
        : legacyKey || hasAnyApiKey()
          ? 'user-keys'
          : localToken
            ? 'local-token'
            : 'none';
      return {
        enabled: mcpConfig?.enabled ?? true,
        authConfigured: authSource !== 'none',
        authSource,
        // The token value itself deliberately does NOT ride this GET: it is
        // revealed only via POST /api/config/mcp/reveal-token so it never lands
        // in GET caches or logs and never leaks through a generic config dump.
        endpoint: `http://localhost:${env.DORKOS_PORT}/mcp`,
        rateLimit: mcpConfig?.rateLimit ?? { enabled: true, maxPerWindow: 60, windowSecs: 60 },
      };
    })(),
    // Fallback mirrors the schema defaults: every channel off until a person
    // says otherwise (ADR 260727-181825). Absence is never read as consent.
    telemetry: configManager.get('telemetry') ?? {
      userHasDecided: false,
      install: false,
      heartbeat: false,
      errorReporting: false,
      lastPromptedVersion: null,
      usage: false,
      linkAnalyticsToAccount: false,
      aiMetadata: false,
    },
    auth: configManager.get('auth') ?? { enabled: false },
    approvals: configManager.get('approvals') ?? {
      standingGrants: false,
      trustWindowMinutes: 480,
    },
    // The two engaged-window ceilings, and only those two. The cockpit prints
    // them inside the sentence that describes the `engaged` response mode —
    // "keeps answering for 10 more minutes or 5 more messages" — so an operator
    // who tuned them would otherwise be reading a sentence about somebody
    // else's install. The rest of the `rooms` block (turn budgets, reply waits)
    // is nothing the cockpit says out loud, so it stays off the wire.
    rooms: (() => {
      const rooms = configManager.get('rooms') ?? USER_CONFIG_DEFAULTS.rooms;
      return {
        engagedWindowMinutes: rooms.engagedWindowMinutes,
        engagedWindowPosts: rooms.engagedWindowPosts,
      };
    })(),
    // Whether agents may greet you when you come back, whether a greeting may
    // spend a turn on a next-step offer, and the two numbers that bound both.
    // Settings offers the two switches; the numbers ride along READ-ONLY for the
    // same reason the `rooms` ceilings do — the switch's own sentence names the
    // threshold in force, and stating the shipped default at somebody who
    // changed it would be a sentence that is false about their install.
    welcomeBack: (() => {
      const welcomeBack = configManager.get('welcomeBack') ?? USER_CONFIG_DEFAULTS.welcomeBack;
      return {
        enabled: welcomeBack.enabled,
        absenceThresholdMinutes: welcomeBack.absenceThresholdMinutes,
        maxPosts: welcomeBack.maxPosts,
        offersEnabled: welcomeBack.offersEnabled,
      };
    })(),
    workbench: configManager.get('workbench') ?? { defaultViewers: {} },
    // Surface the sidebar organization + Shape + status-bar prefs so the client
    // can read them via useConfig() (DOR-329, DOR-355, DOR-431). Schema defaults
    // + the backfill migrations guarantee `ui.sidebar`/`ui.shapes`/`ui.statusBar`
    // are present; the fallbacks cover the pre-migration read window.
    ui: {
      sidebar: configManager.get('ui')?.sidebar ?? SIDEBAR_PREFS_DEFAULTS,
      shapes: configManager.get('ui')?.shapes ?? SHAPE_USER_PREFS_DEFAULTS,
      statusBar: configManager.get('ui')?.statusBar ?? STATUS_BAR_PREFS_DEFAULTS,
      // Whether the message box shows formatting as you type (DOR-948). On the
      // wire because two surfaces read it: the chat composer picks its field
      // from it, and Settings → Advanced shows it back as a switch.
      composer: configManager.get('ui')?.composer ?? COMPOSER_PREFS_DEFAULTS,
      // The standing Full-autonomy acknowledgement (spec `trust-dial`,
      // decision 5). On the wire because the cockpit needs it on two surfaces:
      // it sends the standing ack with every autonomy PATCH so the server's door
      // opens without a second dialog, and Settings shows the date back with a
      // way to clear it. `?? null` covers the pre-migration read window only.
      autonomyAcknowledgedAt: configManager.get('ui')?.autonomyAcknowledgedAt ?? null,
    },
    // The staged opt-ins, RESOLVED (DOR-1304). This is the block that exists
    // because curation is not free: `runtimes.claudeCode.persistentSession`
    // shipped behind a config flag and was unreachable from the cockpit, because
    // nothing above listed it. Anything registered as an experiment is listed
    // here automatically, so the next flag cannot go missing the same way.
    experiments: describeExperiments(),
  });
});

/**
 * The two bars this route puts in front of a guarded setting, expressed as the
 * authority `applyGuardedConfigWrite` asks. The SEQUENCE lives there, shared
 * with `dorkos config set` and the `config_patch` tool; what lives here is the
 * evidence only an HTTP request carries.
 *
 * The bars are named for what they CHECK, never for the order they run in
 * ("first", "bar 2"), because the order carries no meaning and ordinal names rot
 * the moment somebody reorders them, which already happened once and inverted
 * two comments.
 *
 * @param req - The incoming request, for the agent header and approval token.
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @returns The authority for this caller.
 */
function requestConfigWriteAuthority(req: Request, res: Response): ConfigWriteAuthority {
  return {
    // ## THE LOGIN BAR — the standing-permission settings need login on at all
    //
    // The reason it is not folded into the cookie bar is written out at
    // REQUIRES_LOGIN_CONFIG_PATHS: that bar allows every caller while login is
    // off, and for these paths that would leave the switch pre-armable.
    //
    // These settings decide real behavior: the tier gate reads
    // `approvals.standingGrants` on every gated call. The write also persists and
    // nothing sweeps it, so a switch set while login is off would still be set
    // once login is on, reading as something the person chose.
    refuseLoginRequired(paths) {
      const refusal = requireStandingGrantsLogin();
      if (!refusal) return undefined;
      return {
        status: refusal.status,
        code: refusal.code,
        error: REQUIRES_LOGIN_CONFIG_ERROR,
        message: refusal.error,
        paths: [...paths],
      };
    },

    // The REST twin of the guard on `operator.config_patch` (DOR-467). PR #469
    // put the operator-only write policy on the capability surface, but this
    // route reaches the SAME write and had no policy check at all — and with
    // login off `sessionGate` is a documented pass-through, so an agent with a
    // shell could `curl` straight past the guard whose whole promise is that
    // agents cannot change the settings protecting the instance.
    //
    // A patch touching one of those settings has to clear TWO bars, the cookie
    // bar and the agent bar. They refuse different callers and neither one
    // covers the other. Their order decides only WHICH refusal a caller that
    // fails both hears, never what is allowed: the cookie bar goes first so the
    // more specific answer wins, since "sign in first" is more use to a caller
    // than "only a person can change those" when both are true.
    refuseOperatorOnly(paths) {
      // ## THE COOKIE BAR — with login on, prove you are a person in the cockpit
      // (DOR-505)
      //
      // The agent bar is cleared by omitting two headers, which anything
      // with a shell can do; under login-on that included a program holding one of
      // the person's per-user API keys, which `sessionGate` accepts as the same
      // identity a browser session proves (DOR-474). It could write `auth.enabled`
      // here — voiding every approval this instance would ever enforce — while the
      // capability surface refused it that same write. Reproduced against a live
      // server, not reasoned. A session cookie is the one signal a header-stripping
      // caller cannot fake, and under login-on a real operator has one.
      //
      // The enable-login flow is unaffected, and that is load-bearing rather than
      // lucky: `OwnerSetupHost.tsx` writes `auth.enabled: true` while login is
      // still OFF, so this bar does not apply to it. A guard that read the
      // POST-patch state instead of the current state would make login impossible
      // to turn on.
      //
      // ### What stays open, said plainly
      //
      // With login OFF there is no cookie for ANYONE, so THIS bar allows and the
      // agent bar is the only one left. So the hole the agent bar leaves is
      // NOT closed: a program on this machine that omits its agent header can
      // still write every operator-only setting through here. That is the residual
      // DOR-505 could not close, because the cockpit in the default posture
      // presents nothing such a program cannot also present, and refusing it would
      // lock a person out of their own settings. Pinned by a test that says so,
      // and documented for users under "Settings your agents cannot change" in
      // `docs/guides/action-approvals.mdx`. Turning on Require login closes it. Do
      // not describe this route as "operator-only enforced" without that
      // qualifier.
      const cookieRefusal = requireOperatorCookieUnderLogin(
        res,
        'the settings that protect this instance'
      );
      if (cookieRefusal) {
        return {
          status: cookieRefusal.status,
          code: cookieRefusal.code,
          error: OPERATOR_ONLY_CONFIG_ERROR,
          message: cookieRefusal.error,
          paths: [...paths],
        };
      }

      // ## THE AGENT BAR — anything that names itself an agent is refused, in
      // every posture, and in the login-off posture it is the ONLY bar left
      //
      // The cockpit must keep working: its own enable-login and disable-login
      // flows legitimately write `auth.enabled` through here, and under
      // `local-trust` nothing distinguishes the cockpit's request from any other
      // loopback caller. So this bar is skipped for a caller that presents no
      // agent identity and no approval token, and applied to everyone else.
      //
      // ### Do not read `trusted-caller.ts`'s invariant as covering this
      //
      // That module justifies its escape with "whoever may decide an approval may
      // act without one", which rests on the two-step path existing: ask, get the
      // 202, grant it, retry. For operator-only config paths THERE IS NO SUCH
      // PATH. `operator.config_patch` is tier `act`, so its refusal is not an
      // approval gate at all — the capability twin refuses these paths
      // unconditionally, with no approval that could ever unlock them
      // (`OPERATOR_TOOL_AUTHORITY`). For this one effect the trusted escape
      // grants something the two-step path cannot, which is exactly what the
      // cookie bar takes back in the posture where DorkOS has the evidence to.
      if (!trustedCaller(readCallerAuthority(req, res))) {
        return {
          status: 403,
          code: OPERATOR_ONLY_CONFIG_CODE,
          error: OPERATOR_ONLY_CONFIG_ERROR,
          message: describeOperatorOnlyRefusal(paths),
          paths: [...paths],
        };
      }

      return undefined;
    },
  };
}

router.patch('/', (req, res) => {
  try {
    const postureBefore = readStandingGrantPosture();
    // The bars, the autonomy consent door, the write, and the audit line — the
    // sequence `dorkos config set` and the `config_patch` tool also run, so the
    // three doors cannot drift into meaning different things. What this route
    // adds is who the caller is and what a refusal looks like over HTTP.
    const result = applyGuardedConfigWrite({
      patch: req.body,
      authority: requestConfigWriteAuthority(req, res),
      source: 'PATCH /api/config',
    });

    if (!result.ok) {
      if (result.kind === 'invalid') {
        return res.status(400).json({
          error: result.error,
          ...(result.details && { details: result.details }),
        });
      }
      const { status, error, code, paths, message } = result.refusal;
      return res.status(status).json({ error, code, paths, message });
    }

    // Turning login off, or the master switch off, ends every live standing
    // permission. Leaving them dormant would let them wake up later under a
    // posture that can no longer justify them. It stays at the route rather than
    // inside the shared step because it acts on an in-process store of live
    // permissions, which exists in the server and nowhere else.
    revokeStandingGrantsIfPostureNarrowed(postureBefore, readStandingGrantPosture());

    for (const warning of result.warnings) {
      logger.warn(`[Config] ${warning}`);
    }

    return res.json({
      success: true,
      config: result.config,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    });
  } catch (err) {
    logger.error('[Config] PATCH failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** PUT /api/config/agents/defaultAgent — set the default agent by name. */
router.put('/agents/defaultAgent', (req, res) => {
  try {
    const { value } = req.body ?? {};
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: 'Body must include a non-empty "value" string' });
    }

    // Falls back to the schema's own defaults rather than a second copy of them,
    // and writes the STORED spelling of `defaultDirectory` straight back — this
    // route changes the default agent, not where agents live.
    const agents = configManager.get('agents') ?? USER_CONFIG_DEFAULTS.agents;
    configManager.set('agents', { ...agents, defaultAgent: value.trim() });
    // A purpose-built writer: it can only ever move `agents.defaultAgent`, so it
    // takes the audit line rather than the policy the general settings door
    // runs. The line used to be `debug` and named the VALUE — a production
    // install logs at info, so it was never written at all (DOR-1237).
    logConfigWrite('the default-agent route', 'agents', agents, configManager.get('agents'));

    return res.json({ success: true, defaultAgent: value.trim() });
  } catch (err) {
    logger.error('[Config] PUT agents/defaultAgent failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/config/mcp/rotate-token — regenerate the per-instance local MCP
 * token (DOR-278).
 *
 * Only applies in login-off mode with no `MCP_API_KEY` override — those are the
 * only conditions under which the local token gates the surface. When an env
 * override is set or login is on, the local token does not apply, so this 409s
 * rather than silently minting a token that nothing would honor. On success it
 * writes a fresh `0600` token, refreshes the cached value the middleware and the
 * config DTO read, and returns it so the settings tab can show the new value.
 * Rotating invalidates every previously configured client until it re-pastes.
 */
router.post('/mcp/rotate-token', (_req, res) => {
  try {
    if (env.MCP_API_KEY?.trim()) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while MCP_API_KEY is set — that environment variable is the bearer clients use.',
      });
    }
    if (configManager.get('auth')?.enabled === true) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while login is on — clients authenticate with their personal API keys.',
      });
    }

    const dorkHome = resolveDorkHome();
    const localToken = rotateMcpLocalToken(dorkHome);
    return res.json({ localToken });
  } catch (err) {
    logger.error('[Config] POST mcp/rotate-token failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/config/mcp/reveal-token — return the per-instance local MCP token
 * (DOR-278).
 *
 * The token deliberately does not ride `GET /api/config`: a POST-only reveal
 * never lands in GET caches or logs, and the settings tab fetches it on demand
 * instead of every config read carrying the secret. Same applicability rules as
 * rotate: 409 when an `MCP_API_KEY` override is set or login is on (the local
 * token does not apply there).
 *
 * Honest scope note: in login-off mode this endpoint sits behind the same
 * loopback trust boundary as the cockpit, so any local process with socket
 * reach can call it just as the settings tab does — the cockpit and a local
 * process are indistinguishable without login. The reveal endpoint therefore
 * does not (and cannot) make the token unreadable to local callers; turning on
 * login is the boundary that does.
 */
router.post('/mcp/reveal-token', (_req, res) => {
  try {
    if (env.MCP_API_KEY?.trim()) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while MCP_API_KEY is set — that environment variable is the bearer clients use.',
      });
    }
    if (configManager.get('auth')?.enabled === true) {
      return res.status(409).json({
        error:
          'The local MCP token does not apply while login is on — clients authenticate with their personal API keys.',
      });
    }

    const localToken = getMcpLocalToken();
    if (!localToken) {
      return res.status(404).json({
        error:
          'No local MCP token has been generated for this instance. Restart DorkOS to generate one.',
      });
    }
    return res.json({ localToken });
  } catch (err) {
    logger.error('[Config] POST mcp/reveal-token failed', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
