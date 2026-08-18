/**
 * What model, effort and trust level a NEW session starts with, before anybody
 * has chosen anything for it.
 *
 * ## The ladder
 *
 * 1. **The agent's own setting** — an agent whose manifest names a `model` or an
 *    `effort` gets it, per key: an agent that sets only an effort still inherits
 *    the server's model. Read from `.dork/agent.json`, which is the source of
 *    truth for a manifest (ADR-0043), by {@link readAgentExecutionDefaults}.
 *    Each key is dropped where it could not mean anything: the model when the
 *    session lands on a runtime other than the one the manifest names, the
 *    effort on a runtime that has none (OpenCode). A manifest has no trust
 *    level, so that key has no agent tier at all.
 * 2. **The server's per-runtime default** — `runtimes.<runtime>.defaultModel`,
 *    `.defaultEffort` and `.defaultTrustStop`. Per runtime because a model id
 *    only means something inside the runtime that offers it.
 * 3. **The server's global trust stop** — `runtimes.defaultTrustStop`, for the
 *    one key that is runtime-NEUTRAL. "Ask first" means the same thing wherever
 *    it is heard, so a person who wants it everywhere says so once; the
 *    per-runtime leaf above beats it where they wanted something narrower
 *    (spec `trust-dial`, decision 6).
 * 4. **Nothing** — the settings are left unset, so the runtime picks, which is
 *    exactly the behavior before any of this existed. This is what `null` in the
 *    config means, and it is the shipped default.
 *
 * ## The trust stop is a stop, not a mode
 *
 * Config stores `'ask' | 'act' | 'autonomy'`; a session stores a runtime mode
 * id. The translation is the runtime's own capability profile, read through
 * {@link resolveTrustStops} — the SAME function the dial renders from, so the
 * mode a default lands on is by construction the mode the dial would show as
 * selected, including the first-declared rule where a runtime declares two modes
 * at one stop. A runtime with no mode at the configured stop contributes
 * nothing and starts at its own default.
 *
 * **Interactive sessions only.** The permission tier answers only when the
 * caller passes the runtime's declared modes, and only the interactive
 * session-creation path does (`RuntimeRegistry.persistSessionRuntime` with
 * `interactive: true`). Tasks, bindings and rooms carry their own permission
 * mode and their own stricter gates — including the bypass clamp on
 * file-sourced schedules — and this default must never reach them (decision 6).
 *
 * ## Where the answer lands
 *
 * Into `session_metadata` at the write that BINDS the session to a runtime, and
 * only there. Every adapter already resolves a turn as `per-send override →
 * persisted → its own default`, so seeding the persisted row is the one change
 * that makes all three inherit — no adapter learns about config, and a value the
 * person later sets on the session simply overwrites the seed.
 *
 * **The binding write, and not merely the first one**, which is the correction
 * DOR-812 made: changing a setting before sending the first message also creates
 * the row, and that write cannot seed anything, because every answer above is a
 * per-runtime answer and it does not know the runtime. So the row it leaves
 * holds the person's explicit choices alone, and `persistSessionRuntime` fills
 * the rest when the first turn names an owner — filling only columns still
 * holding NULL, so an explicit choice always wins.
 *
 * A bound row is never touched. That is what keeps the promise the settings
 * screen makes — "applies to new conversations, running ones keep their
 * settings" — true for a person who changes the default while ten sessions are
 * open.
 *
 * @module services/session/resolve-session-defaults
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { ExecutionDefaults, PermissionMode, SessionSettings } from '@dorkos/shared/types';
import type {
  PermissionModeDescriptor,
  PermissionStop,
  RuntimeCapabilities,
  RuntimeSettingsCapability,
} from '@dorkos/shared/agent-runtime';
import { readManifest } from '@dorkos/shared/manifest';
import { resolveTrustStops } from '@dorkos/shared/permission-semantics';
import { configManager } from '../core/config-manager.js';

/**
 * What one agent says its sessions should start with — the ladder's first tier.
 *
 * Both keys are independent and both may be absent; absent means "no opinion,
 * ask the next tier", never "unset it".
 */
export interface AgentExecutionDefaults {
  /**
   * The runtime the agent's `model` was chosen for — the manifest's own
   * `runtime` field, not the runtime the session ends up on. The two can differ
   * (see {@link resolveSessionDefaults}), and telling them apart is the only way
   * to know whether the model id means anything here.
   *
   * Absent means the caller makes no claim about which runtime the model was
   * written for, and the model is taken at face value. `readManifest` never
   * produces that shape — `runtime` is required on the manifest — so it is a
   * statement only a programmatic caller can make.
   */
  runtime?: string;
  /** The model the agent names, in its own runtime's id space. */
  model?: string;
  /** The effort rung the agent names. */
  effort?: SessionSettings['effort'];
}

/**
 * Read an agent's execution defaults off its manifest.
 *
 * Tolerant by construction: no directory, no manifest, an unreadable file, or a
 * manifest that names neither field all answer the same "no opinion". A session
 * must always be startable — a manifest problem is a reason to fall through to
 * the server's default, never a reason to refuse the turn.
 *
 * The values are returned exactly as written, including ones the agent's model
 * may not honor — that is the design's accepted-at-write rule (§3.4): the
 * mismatch is reported to the person as a warning chip, because a model catalog
 * is remote and a runtime can be disconnected while somebody edits.
 *
 * Whether a RUNTIME can honor an effort at all is a different question, and it
 * is not answered here: this function does not know which runtime the session is
 * bound to. {@link resolveSessionDefaults} drops an effort for a runtime that
 * declares `settings.supportsEffort: false`, which is the difference between "we
 * are not sure your model likes this" and "this runtime has no such setting".
 *
 * @param manifestDir - The agent's project directory (the one holding `.dork/`).
 *   Omitted → no agent tier at all.
 */
export async function readAgentExecutionDefaults(
  manifestDir?: string
): Promise<AgentExecutionDefaults> {
  if (!manifestDir) return {};
  try {
    const manifest = await readManifest(manifestDir);
    if (!manifest) return {};
    return {
      // The manifest's own runtime travels with its model, because it is what
      // makes the model id readable — see `AgentExecutionDefaults.runtime`.
      runtime: manifest.runtime,
      ...(manifest.model !== undefined ? { model: manifest.model } : {}),
      ...(manifest.effort !== undefined ? { effort: manifest.effort } : {}),
    };
  } catch {
    return {};
  }
}

/** The `runtimes.*` config keys that actually exist in {@link UserConfig}. */
const RUNTIMES_CONFIG_SECTIONS = ['claudeCode', 'codex', 'opencode'] as const;

/** One of the config keys a runtime's execution defaults can live under. */
type RuntimesConfigSection = (typeof RUNTIMES_CONFIG_SECTIONS)[number];

/**
 * Whether a runtime-declared config section is one this config file has.
 *
 * The declaration is typed `string | null` in shared because the config schema
 * is host-side; this is where the two meet. A section this build does not know
 * is skipped rather than thrown on, so a newer adapter never breaks the screen.
 */
function isRuntimesConfigSection(section: string | null): section is RuntimesConfigSection {
  return section !== null && (RUNTIMES_CONFIG_SECTIONS as readonly string[]).includes(section);
}

/**
 * Resolve the execution settings a new session on this runtime should start with.
 *
 * Returns only the keys that have an answer — an omitted key means "no
 * preference", which is what a NULL column and an unset session setting both
 * already mean everywhere else.
 *
 * @param opts.runtimeType - The runtime the new session is bound to.
 * @param opts.agent - The owning agent's manifest values, from
 *   {@link readAgentExecutionDefaults}. Omitted → the session has no agent, or
 *   the caller does not know which one, and the ladder starts at tier 2.
 * @param opts.runtimes - The `runtimes` config section; defaults to the stored one.
 * @param opts.configSection - Which `runtimes.*` key holds this runtime's own
 *   defaults, from the runtime's declared `settings.configSection`. The runtime
 *   is the authority on that (it is the same declaration
 *   {@link describeExecutionDefaults} reports the settings card from), and it
 *   arrives as an argument because reaching the registry from here would be an
 *   import cycle — the registry already imports this module. **Omitted or `null`
 *   means the runtime has no section of its own**, which is a real answer rather
 *   than an oversight: `test-mode` is exactly that, and it gets what it got
 *   before any of this existed — no per-runtime default, and the global trust
 *   stop below still applies.
 * @param opts.supportsEffort - Whether the bound runtime takes an effort setting
 *   at all, from its declared `settings.supportsEffort`. **Omitted means the
 *   caller does not know**, and the safe direction there is `true`: an effort is
 *   dropped only where a runtime has said out loud that it has none, so a new
 *   adapter nobody has wired this through yet is never silently muted. The
 *   opposite default would make an agent's `effort: 'high'` quietly stop
 *   applying the day a runtime is added, with nothing on screen to say why.
 * @param opts.permissionModes - Every mode the bound runtime declares, in its
 *   declared order, from its capability profile. **Omitted means no permission
 *   tier at all**, and that is the safe direction rather than an oversight: the
 *   default is for attended sessions, so a caller that has not said it is one
 *   gets what it got before this existed. Forgetting to pass it makes a
 *   preference not apply; passing it from an unattended surface would start an
 *   unwatched agent somewhere nobody chose.
 */
export function resolveSessionDefaults(opts: {
  runtimeType: string;
  agent?: AgentExecutionDefaults;
  runtimes?: UserConfig['runtimes'];
  configSection?: string | null;
  supportsEffort?: boolean;
  permissionModes?: readonly PermissionModeDescriptor[];
}): SessionSettings {
  // Tier 1 — the agent's own model/effort, which outranks the server's default
  // for whichever of the two keys it names. The two keys are gated differently,
  // and the difference is the design's, not this function's: a model id lives in
  // ONE runtime's namespace (§8, which is why the server's default model is
  // per-runtime at all), while the effort ladder is a single normalized enum
  // every runtime maps into (§4, "Reuse; never fork").
  //
  // So the MODEL applies only when the session actually lands on the runtime the
  // manifest wrote it for. Those come apart in a degraded mode that is real and
  // deliberately tolerated: `registerOptionalRuntime` lets a runtime fail to
  // register — the packaged desktop app bundles only the claude-code SDK — and
  // both runtime resolvers then fall back to the default rather than refusing
  // the turn. Without this check, an agent with `runtime: 'codex'` addressed in
  // a room on such a build starts a claude-code session seeded with
  // `gpt-5.3-codex`. That is not §3.4's "a model your runtime may not currently
  // offer", which is accepted-at-write and reported; it is an id from another
  // provider's namespace, which cannot become valid and is nobody's preference.
  // A session on the wrong runtime falls back to the server's default for THAT
  // runtime, which is the only value that can mean anything to it.
  //
  // The EFFORT survives the mismatch: "think harder" is the same request on any
  // runtime that can hear it. What it does not survive is a runtime with no
  // effort at its API — OpenCode — because a value stored there comes back out
  // at the person as a setting that does nothing, and "Not supported by
  // OpenCode" is only true if nothing here quietly supplies one anyway. Which
  // runtimes those are is each runtime's own declaration now, arriving as
  // `opts.supportsEffort`; unanswered reads as yes, so the drop only ever
  // happens where a runtime said it has none.
  const modelIsForThisRuntime =
    opts.agent?.runtime === undefined || opts.agent.runtime === opts.runtimeType;
  const fromAgent: SessionSettings = {
    ...(opts.agent?.model !== undefined && modelIsForThisRuntime
      ? { model: opts.agent.model }
      : {}),
    ...(opts.agent?.effort !== undefined && (opts.supportsEffort ?? true)
      ? { effort: opts.agent.effort }
      : {}),
  };

  // Tier 2 — the server's per-runtime default, under the section the runtime
  // itself declares. The type guard is what keeps a declaration this build has
  // no config key for from reading an undefined leaf: skipped, never thrown on.
  const declared = opts.configSection ?? null;
  const section = isRuntimesConfigSection(declared) ? declared : undefined;
  // Both `?.`s are load-bearing, and neither is decoration. `configManager` is a
  // `let` that is undefined until `initConfigManager` runs, and this is now
  // consulted by `RuntimeRegistry` on every row it creates — so a registry used
  // before the server has read its config would otherwise throw where it
  // previously worked. The section can also be absent on a config the schema has
  // not filled in. Both mean the same thing and get the same answer: no
  // preference, so the runtime chooses. A missing setting is a reason to start
  // the session on the runtime's own default, never a reason to refuse to start
  // it — the same tolerance `readStandingGrantVoidFloor`
  // (`core/approvals/standing-grant-settings.ts`) and `resolveActiveClaudeRoot`
  // already apply to this singleton, and for the same reason: the declared type
  // does not admit that a boot-wired `let` is undefined before boot.
  const runtimes = opts.runtimes ?? configManager?.get('runtimes');
  const configured = section ? runtimes?.[section] : undefined;
  const settings: SessionSettings = { ...fromAgent };
  if (configured) {
    if (settings.model === undefined && configured.defaultModel != null) {
      settings.model = configured.defaultModel;
    }
    // OpenCode's section has no `defaultEffort` — its API accepts no effort, so
    // the field does not exist rather than existing and doing nothing.
    if (
      settings.effort === undefined &&
      'defaultEffort' in configured &&
      configured.defaultEffort != null
    ) {
      settings.effort = configured.defaultEffort;
    }
  }

  // Tiers 2 and 3 for the trust stop, which is the one key with a GLOBAL tier
  // under the per-runtime one — see the module doc. A runtime with no config
  // section still reads the global stop: the value is runtime-neutral by
  // construction, so "every new session asks first" has to mean every runtime,
  // not every runtime somebody wrote a settings section for.
  const mode = resolveTrustMode({
    stop: configured?.defaultTrustStop ?? runtimes?.defaultTrustStop ?? null,
    descriptors: opts.permissionModes,
  });
  if (mode !== undefined) settings.permissionMode = mode;

  // Tier 4 — whatever is still unset stays unset, and the runtime decides.
  return settings;
}

/**
 * The settings a turn NOBODY IS WATCHING starts a new session with — the whole
 * ladder above, in one call, for the surfaces that trigger a turn on their own.
 *
 * Two surfaces share it and must keep answering identically for the same agent:
 * a room turn (`rooms/room-turn-runner.ts`) and a relay-triggered turn
 * (`relay/turn-execution-settings.ts`). Before this existed the room resolved
 * the ladder and the relay resolved nothing at all, so an agent pinned to one
 * model answered a colleague on whatever the server defaulted to (DOR-1344).
 * Two call sites resolving the same question is how they came apart; this is
 * the one place that answers it, so they cannot again.
 *
 * **No permission tier, ever.** {@link resolveSessionDefaults} answers the trust
 * stop only for a caller that hands it the runtime's declared modes, and no
 * caller here does: the configured default is for sessions a person is watching
 * (spec `trust-dial`, decision 6). A room and a relay binding each carry their
 * own permission mode and their own stricter gates, and the answer here must
 * never displace one.
 *
 * **New sessions only.** A session that already has settings is a running
 * conversation and keeps them — "applies to new conversations, running ones keep
 * their settings". Which is each caller's own check, because the two differ in
 * what they then do about it: a room hands the runtime nothing and lets it
 * hydrate the row itself, while the relay creates the session record before the
 * runtime would, so it has to pass the stored values through.
 *
 * @param opts.runtimeType - The runtime the turn will actually run on.
 * @param opts.agentPath - The addressed agent's directory, the one holding
 *   `.dork/agent.json`. Omitted → no agent tier, and the ladder starts at the
 *   server's per-runtime default.
 * @param opts.declared - The runtime's own `settings` capability, which is the
 *   authority on where its defaults live and whether it takes an effort at all.
 *   Omitted → neither is known, and the safe direction for each is
 *   {@link resolveSessionDefaults}'s.
 */
export async function resolveUnattendedSessionDefaults(opts: {
  runtimeType: string;
  agentPath?: string;
  declared?: Pick<RuntimeSettingsCapability, 'configSection' | 'supportsEffort'>;
}): Promise<SessionSettings> {
  return resolveSessionDefaults({
    runtimeType: opts.runtimeType,
    agent: await readAgentExecutionDefaults(opts.agentPath),
    configSection: opts.declared?.configSection,
    supportsEffort: opts.declared?.supportsEffort,
  });
}

/**
 * Turn a configured dial position into the mode id this runtime calls it.
 *
 * The one rule, and it is not this module's: {@link resolveTrustStops} is what
 * the dial itself renders from, so a default lands on exactly the mode the dial
 * would show as selected — including where a runtime declares two modes at one
 * stop and its own declared order decides which the position means (Claude
 * Code's `acceptEdits` before `auto`). Re-deriving that here would be a second
 * answer to a question that already has one.
 *
 * Answers `undefined` — "no preference, the runtime decides" — in three cases
 * that are all the same case: nothing configured, no descriptors in hand (the
 * caller is not an attended session), or a runtime that declares no mode at the
 * configured stop. A stop a runtime cannot take is not an error and not a
 * near-miss to round off; it is a preference this runtime has no way to honor.
 *
 * @param opts.stop - The configured dial position, or `null` for none.
 * @param opts.descriptors - The runtime's declared modes, in declared order.
 * @internal
 */
function resolveTrustMode(opts: {
  stop: PermissionStop | null;
  descriptors: readonly PermissionModeDescriptor[] | undefined;
}): PermissionMode | undefined {
  if (!opts.stop || !opts.descriptors) return undefined;
  const match = resolveTrustStops(opts.descriptors).find((s) => s.stop === opts.stop);
  // The cast is the wire's legacy narrowing, not a claim about this id.
  // `PermissionMode` is a closed enum of the ids the three shipped runtimes
  // happen to use, while a mode id is whatever its runtime declared (test-mode's
  // `always-allow`) and the column holding it is plain text. The id here came
  // from the runtime's own profile, so it is by definition one that runtime runs.
  return match ? (match.mode.id as PermissionMode) : undefined;
}

/**
 * Report the server's execution defaults for `GET /api/config` — the read half
 * of the settings card.
 *
 * These leaves are writable through `PATCH /api/config` already, but
 * `GET /api/config` is a curated view rather than the raw user config, so
 * nothing reported them back and a card over them could not show what was set.
 * This is that report, and nothing more: it reads a runtime's defaults from the
 * section that runtime DECLARES (`settings.configSection`), which is the same
 * declaration {@link resolveSessionDefaults} is handed, so the screen and the
 * resolver can never disagree about where a runtime's default lives. There is no
 * second list here to keep in step with the adapters.
 *
 * A runtime that declares no config section is simply absent — `test-mode` has
 * no default and never will, and absence is how that is said. So is a runtime
 * declaring a section this build has no config key for: skipped, never thrown
 * on, so a newer adapter cannot take the settings screen down with it.
 *
 * And so is a runtime that is not in the capabilities map at all, which is what
 * a disabled runtime looks like from here (`runtimes.codex.enabled: false`
 * keeps codex out of the registry, so it is out of this report too). Its stored
 * per-runtime defaults are untouched by that: they stay in config, and they
 * start applying again the moment the runtime comes back. This report covers
 * each REGISTERED runtime (spec `runtimes-settings-redesign` §C), so while a
 * runtime is off, its defaults are simply not reported.
 *
 * @param capabilities - Every registered runtime's capability profile, keyed by
 *   runtime type — `runtimeRegistry.getAllCapabilities()`. Required, and passed
 *   in rather than read here, because the registry already imports this module
 *   and importing it back would be a cycle. Required so that every call site is
 *   compile-forced to supply the one map this report is derived from.
 * @param runtimes - The `runtimes` config section; defaults to the stored one.
 *   Both `?.`s below are for the same pre-boot window {@link resolveSessionDefaults}
 *   documents: a missing section reports "no preference", never an error.
 */
export function describeExecutionDefaults(
  capabilities: Record<string, RuntimeCapabilities>,
  runtimes?: UserConfig['runtimes']
): ExecutionDefaults {
  const stored = runtimes ?? configManager?.get('runtimes');
  return {
    runtime: stored?.default ?? 'claude-code',
    // The global stop, reported beside the per-runtime ones so the card can show
    // both halves of the override it offers. `null` is "the runtime decides",
    // which is the shipped state and a real answer, not a missing one.
    trustStop: stored?.defaultTrustStop ?? null,
    perRuntime: Object.entries(capabilities)
      // By runtime type id, and by code unit rather than locale: registration
      // order is a startup detail nobody chose, and a list that reshuffles under
      // the person's cursor between two reads is the thing to avoid.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      // `flatMap` over `filter` + `map` so the type guard narrows the section key
      // for the read below — one pass, no re-checking what was already decided.
      .flatMap(([runtime, capability]) => {
        const key = capability.settings.configSection;
        if (!isRuntimesConfigSection(key)) return [];
        const configured = stored?.[key];
        const supportsEffort = capability.settings.supportsEffort;
        return [
          {
            runtime,
            model: configured?.defaultModel ?? null,
            // What THIS runtime overrides the global stop with; `null` = it
            // doesn't. Reported unresolved: which mode id the stop lands on is
            // the runtime's capability profile's answer, and the cockpit already
            // holds those profiles, so resolving it here would put a second copy
            // of that translation on the wire for the screen to disagree with.
            trustStop: configured?.defaultTrustStop ?? null,
            // OpenCode's section has no `defaultEffort` key at all — the `in`
            // check is what keeps that structural absence and a configured
            // `null` the same answer here, rather than a type assertion that
            // would outlive the fact.
            effort:
              supportsEffort && configured && 'defaultEffort' in configured
                ? (configured.defaultEffort ?? null)
                : null,
            supportsEffort,
          },
        ];
      }),
  };
}
