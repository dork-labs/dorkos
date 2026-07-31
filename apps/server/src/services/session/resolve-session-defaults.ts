/**
 * What model and effort a NEW session starts with, before anybody has chosen
 * anything for it.
 *
 * ## The ladder
 *
 * 1. **The agent's own setting** — an agent whose manifest names a model or an
 *    effort gets it. Not yet: the manifest fields land with E2 of the
 *    `execution-defaults` spec, so today this tier resolves to nothing. The slot
 *    is labeled below rather than left implicit, because the ORDER is the design
 *    decision and it should be readable before the fields exist.
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
import type { SessionSettings } from '@dorkos/shared/types';
import { configManager } from '../core/config-manager.js';

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
 * @param opts.runtimes - The `runtimes` config section; defaults to the stored one.
 */
export function resolveSessionDefaults(opts: {
  runtimeType: string;
  runtimes?: UserConfig['runtimes'];
}): SessionSettings {
  // Tier 1 — the agent's own model/effort. Arrives with E2 (agent manifest
  // fields); until then no agent can express one, so nothing shadows tier 2.

  // Tier 2 — the server's per-runtime default.
  const section = CONFIG_SECTION_BY_RUNTIME[opts.runtimeType];
  if (!section) return {};
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
  if (!configured) return {};
  const settings: SessionSettings = {};
  if (configured.defaultModel != null) settings.model = configured.defaultModel;
  // OpenCode's section has no `defaultEffort` — its API accepts no effort, so
  // the field does not exist rather than existing and doing nothing.
  if ('defaultEffort' in configured && configured.defaultEffort != null) {
    settings.effort = configured.defaultEffort;
  }

  // Tier 3 — whatever is still unset stays unset, and the runtime decides.
  return settings;
}
