/**
 * What model and effort a NEW session starts with, before anybody has chosen
 * anything for it.
 *
 * ## The ladder
 *
 * 1. **The agent's own setting** — an agent whose manifest names a `model` or an
 *    `effort` gets it, per key: an agent that sets only an effort still inherits
 *    the server's model. Read from `.dork/agent.json`, which is the source of
 *    truth for a manifest (ADR-0043), by {@link readAgentExecutionDefaults}.
 *    Each key is dropped where it could not mean anything: the model when the
 *    session lands on a runtime other than the one the manifest names, the
 *    effort on a runtime that has none (OpenCode).
 * 2. **The server's per-runtime default** — `runtimes.<runtime>.defaultModel` and
 *    `.defaultEffort`. Per runtime because a model id only means something inside
 *    the runtime that offers it.
 * 3. **Nothing** — the settings are left unset, so the runtime picks, which is
 *    exactly the behavior before any of this existed. This is what `null` in the
 *    config means, and it is the shipped default.
 *
 * ## Where the answer lands
 *
 * Into `session_metadata` at the session's first write, and only there. Every
 * adapter already resolves a turn as `per-send override → persisted → its own
 * default`, so seeding the persisted row is the one change that makes all three
 * inherit — no adapter learns about config, and a value the person later sets
 * on the session simply overwrites the seed.
 *
 * **"The first write" is not one caller**, which is why `RuntimeRegistry` owns
 * the seeding rather than the message route: the first message writes the
 * runtime binding, and changing a setting BEFORE that message writes the row
 * first. Both go through `seedForNewRow`, on the INSERT branch and under the
 * caller's own values, so an explicit choice always wins and only the keys a
 * write does not carry are filled.
 *
 * First write means FIRST: an existing row is never touched. That is what keeps
 * the promise the settings screen makes — "applies to new conversations, running
 * ones keep their settings" — true for a person who changes the default while
 * ten sessions are open.
 *
 * @module services/session/resolve-session-defaults
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { ExecutionDefaults, SessionSettings } from '@dorkos/shared/types';
import { readManifest } from '@dorkos/shared/manifest';
import { runtimeSupportsEffort } from '@dorkos/shared/constants';
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
 * bound to. {@link resolveSessionDefaults} drops an effort for a runtime whose
 * API has none (`runtimeSupportsEffort`), which is the difference between "we
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

/**
 * Which config section holds a runtime's execution defaults.
 *
 * Runtime type ids are kebab-case on the wire and camelCase in config, and the
 * two lists are allowed to differ: `test-mode` is a real runtime with no config
 * section, and a runtime absent here simply has no server default — never an
 * error.
 */
const CONFIG_SECTION_BY_RUNTIME: Readonly<Record<string, 'claudeCode' | 'codex' | 'opencode'>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
};

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
 */
export function resolveSessionDefaults(opts: {
  runtimeType: string;
  agent?: AgentExecutionDefaults;
  runtimes?: UserConfig['runtimes'];
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
  // OpenCode" is only true if nothing here quietly supplies one anyway.
  const modelIsForThisRuntime =
    opts.agent?.runtime === undefined || opts.agent.runtime === opts.runtimeType;
  const fromAgent: SessionSettings = {
    ...(opts.agent?.model !== undefined && modelIsForThisRuntime
      ? { model: opts.agent.model }
      : {}),
    ...(opts.agent?.effort !== undefined && runtimeSupportsEffort(opts.runtimeType)
      ? { effort: opts.agent.effort }
      : {}),
  };

  // Tier 2 — the server's per-runtime default.
  const section = CONFIG_SECTION_BY_RUNTIME[opts.runtimeType];
  if (!section) return fromAgent;
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
  const configured = runtimes?.[section];
  if (!configured) return fromAgent;
  const settings: SessionSettings = { ...fromAgent };
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

  // Tier 3 — whatever is still unset stays unset, and the runtime decides.
  return settings;
}

/**
 * Report the server's execution defaults for `GET /api/config` — the read half
 * of the settings card.
 *
 * These leaves are writable through `PATCH /api/config` already, but
 * `GET /api/config` is a curated view rather than the raw user config, so
 * nothing reported them back and a card over them could not show what was set.
 * This is that report, and nothing more: it reads exactly the same config
 * sections {@link resolveSessionDefaults} reads, through the same
 * {@link CONFIG_SECTION_BY_RUNTIME} map, so the screen and the resolver can
 * never disagree about which section a runtime's default lives in.
 *
 * A runtime with no config section is simply absent — `test-mode` has no
 * default and never will, and absence is how that is said.
 *
 * @param runtimes - The `runtimes` config section; defaults to the stored one.
 *   Both `?.`s below are for the same pre-boot window {@link resolveSessionDefaults}
 *   documents: a missing section reports "no preference", never an error.
 */
export function describeExecutionDefaults(runtimes?: UserConfig['runtimes']): ExecutionDefaults {
  const section = runtimes ?? configManager?.get('runtimes');
  return {
    runtime: section?.default ?? 'claude-code',
    perRuntime: Object.entries(CONFIG_SECTION_BY_RUNTIME).map(([runtime, key]) => {
      const configured = section?.[key];
      const supportsEffort = runtimeSupportsEffort(runtime);
      return {
        runtime,
        model: configured?.defaultModel ?? null,
        // OpenCode's section has no `defaultEffort` key at all — the `in` check
        // is what keeps that structural absence and a configured `null` the same
        // answer here, rather than a type assertion that would outlive the fact.
        effort:
          supportsEffort && configured && 'defaultEffort' in configured
            ? (configured.defaultEffort ?? null)
            : null,
        supportsEffort,
      };
    }),
  };
}
