/**
 * The agents directory default and the `extensions`, `mcp`, `workspace`, `harness` and `workbench` sections of `UserConfigSchema`.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/tooling
 */
import { z } from 'zod';
import {
  ApprovedPermissionSetSchema,
  ExtensionApprovedSourceSchema,
  ExtensionDismissedApprovalSchema,
  ExtensionTrustedSourceSchema,
} from '../extension-config-schemas.js';
// `HARNESS_IDS`, never `HarnessIdSchema`. This module is one of the five
// `@dorkos/shared/*` subpaths `apps/server/vitest.config.ts` aliases to SRC for
// every vitest project, so a test process holds both the src and the dist copy
// of it — safe only while what it imports is schemas, constants and pure
// functions with no compared identity. A Zod schema imported here would drag a
// SECOND `harness-schemas` into the src copy, built on the zod instance vite
// inlines, and the `.openapi()` prototype patch would land on one instance while
// the registry asked the other. See `harness-ids.ts` for the measurement.
import { HARNESS_IDS } from '../harness-ids.js';

/**
 * The shipped default for `agents.defaultDirectory`.
 *
 * **A portable spelling of `{dorkHome}/agents`, not a literal filesystem path.**
 * It is stored rather than an absolute path so a config survives a home
 * directory that moves or is copied between machines — and because the DorkOS
 * data directory is only `~/.dork` in a normal production install. Whenever
 * `DORK_HOME` is redirected (a dev tree, a Docker deployment, a test), the
 * agents DorkOS creates belong under THAT directory.
 *
 * So the server never tilde-expands this value directly. `resolveAgentsDirectory()`
 * (`apps/server/src/lib/agents-home.ts`) maps this exact string onto the data
 * directory actually in use, and expands `~` against the person's real home only
 * for a directory they chose themselves. Expanding the default against the real
 * home is what let agent creation from a dev tree write into an operator's live
 * `~/.dork/agents` (DOR-662).
 */
export const DEFAULT_AGENTS_DIRECTORY = '~/.dork/agents';

/** The `extensions` section of `UserConfigSchema`; its documentation sits on the field there. */
export const ExtensionsConfigSchema = z
  .object({
    // `enabled` and `disabled` record DEVIATIONS from each extension's default
    // state, à la JetBrains' `disabled_plugins.txt` generalized to two defaults.
    /** Extension IDs the user turned ON that default OFF (user/marketplace + default-off core). */
    enabled: z.array(z.string()).default(() => []),
    /** Extension IDs the user turned OFF that default ON (default-on core). */
    disabled: z.array(z.string()).default(() => []),
    /**
     * Extension IDs a person has approved to RUN CODE inside the DorkOS server
     * process (DOR-516).
     *
     * Not a deviation list and not an on/off switch: it is a standing consent
     * about one artifact, and it is deliberately independent of `enabled`.
     * Enabling an extension says "I want this in my cockpit"; approving it says
     * "I have looked at this code and DorkOS may execute it in-process, with the
     * server's own privileges and outside the tier gate". Turning an extension
     * off and on again must not re-ask, and re-asking on every compile of a
     * half-written extension is exactly the routine-card harm this repo avoided
     * on DOR-504/DOR-506 — so the approval is keyed to the extension id and
     * survives the whole edit-test-reload loop.
     *
     * Core extensions (`origin: 'core'`) are NOT listed here and never need to
     * be: they ship inside the DorkOS binary the person already installed, so
     * requiring a click for them would gate DorkOS on approving itself. Only
     * `origin: 'user'` extensions — anything an agent scaffolded, or the
     * marketplace installed — are gated. See `extension-load-policy.ts`.
     *
     * `operator-only` in `config-write-policy.ts`: an agent that could add its
     * own id here would be approving its own code.
     */
    approvedToRun: z.array(z.string()).default(() => []),
    /**
     * Which copy of each approved extension the approval was given to, keyed
     * by extension id (DOR-2383).
     *
     * An id in `approvedToRun` with no entry here counts as NOT approved,
     * except that an approval given before this map existed is bound, on the
     * first discovery that finds it, to the extension installed directly
     * under `{dorkHome}/extensions/<id>` — the only copy it could have been
     * about. A copy at any other path, inside any other plugin, asks again.
     *
     * `operator-only` for the same reason as `approvedToRun`.
     */
    approvedSources: z.record(z.string(), ExtensionApprovedSourceSchema).default(() => ({})),
    /**
     * The permission set each approval covers, keyed by extension id
     * (DOR-2686): what the extension declared when a person said yes.
     *
     * A missing entry means the full in-process set: every approval given
     * before this map existed was for an extension running inside DorkOS
     * with full access, so it still covers anything. An extension whose
     * declared set is wider than its entry (a new host, program or agent
     * access) does not run until a person approves again; a narrower one
     * keeps running with nothing to click.
     *
     * `operator-only` for the same reason as `approvedToRun`: a caller that
     * could widen an entry would widen a person's yes.
     */
    approvedPermissions: z.record(z.string(), ApprovedPermissionSetSchema).default(() => ({})),
    /**
     * The copies a person said "Not now" to in the Activity inbox, keyed by
     * extension id (DOR-2517). Each entry silences the inbox row for that
     * exact path, plugin and version; any change asks again. Cleared for an
     * id when that id is approved.
     *
     * `operator-only`, like `approvedSources`: it records a person's answer
     * to a consent question, and an agent that could write it could hide the
     * question from them.
     */
    dismissedApprovals: z.record(z.string(), ExtensionDismissedApprovalSchema).default(() => ({})),
    /**
     * The code sources a person trusts (spec `flow-multiproject` §9.3): an
     * extension whose copy provably came from one of these runs without an
     * approval row. Keyed on a trusted origin's `owner/repo`, so a clone
     * that merely claims a source is never covered.
     *
     * `operator-only`: it decides which code runs. Trusting a new source is
     * one of the three asks only a person can answer.
     */
    trustedSources: z.array(ExtensionTrustedSourceSchema).default(() => []),
    /**
     * The rooms each mini app may read and reply in as the person, keyed by
     * extension id (DOR-3017). A missing id, or an empty list, means none: a
     * mini app reaches no room until a person picks one in Settings →
     * Extensions. Reads still follow the person's own room membership.
     *
     * Optional rather than defaulted: absence already means "no rooms", so
     * there is nothing for a migration to seed.
     *
     * `operator-only`: a caller that could add a room here would let a mini
     * app post in the person's name somewhere they never chose.
     */
    roomAccess: z.record(z.string(), z.array(z.string().min(1)).max(50)).optional(),
    /**
     * The agents each mini app may forward the person's typed comments to,
     * keyed by extension id, as Mesh agent ids, never names (DOR-3325). A
     * forward arrives in the person's Direct chat with one of them as their
     * own words, so the list is the person's choice alone: set in Settings →
     * Extensions, or by Allow on the core first-use prompt. A missing id, or
     * an empty list, means none, and every forward is refused.
     *
     * Optional rather than defaulted: absence already means "no agents", so
     * there is nothing for a migration to seed.
     *
     * `operator-only`: a caller that could add an agent here would let a mini
     * app make the person say something to an agent they never chose.
     */
    forwardAgents: z.record(z.string(), z.array(z.string().min(1).max(200)).max(20)).optional(),
  })
  .default(() => ({
    enabled: [],
    disabled: [],
    approvedToRun: [],
    approvedSources: {},
    approvedPermissions: {},
    dismissedApprovals: {},
    trustedSources: [],
  }));

/** The `mcp` section of `UserConfigSchema`; its documentation sits on the field there. */
export const McpConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    apiKey: z.string().nullable().default(null),
    rateLimit: z
      .object({
        enabled: z.boolean().default(true),
        maxPerWindow: z.number().int().min(1).max(1000).default(60),
        windowSecs: z.number().int().min(1).max(3600).default(60),
      })
      .default(() => ({ enabled: true, maxPerWindow: 60, windowSecs: 60 })),
  })
  .default(() => ({
    enabled: true,
    apiKey: null,
    rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
  }));

/** The `workspace` section of `UserConfigSchema`; its documentation sits on the field there. */
export const WorkspaceConfigSchema = z
  .object({
    /** Whether the WorkspaceManager is active (binding sessions, allocating ports). */
    enabled: z.boolean().default(true),
    /** Workspace root override; `null` resolves to `<dorkHome>/workspaces`. */
    rootPath: z.string().nullable().default(null),
    /** First port of the allocation pool. */
    portBase: z.number().int().min(1024).max(65535).default(4250),
    /** Contiguous ports reserved per workspace (≥3 for DORKOS/VITE/SITE). */
    portBlockSize: z.number().int().min(3).max(100).default(10),
    /** Default provider when a caller does not specify one. */
    defaultProvider: z.enum(['worktree', 'clone']).default('worktree'),
    /** Optional cap on retained workspaces; `null` disables the age/cap sweep. */
    retentionCap: z.number().int().min(0).nullable().default(null),
  })
  .default(() => ({
    enabled: true,
    rootPath: null,
    portBase: 4250,
    portBlockSize: 10,
    defaultProvider: 'worktree' as const,
    retentionCap: null,
  }));

/** The `harness` section of `UserConfigSchema`; its documentation sits on the field there. */
export const HarnessConfigSchema = z
  .object({
    /**
     * Whether DorkOS runs Harness Sync projection on its own (re-projecting
     * `.agents/` + installed plugins to every harness a project enables).
     *
     * It gates every UNPROMPTED trigger, and there are five: a marketplace
     * plugin installed or uninstalled at project scope, an agent registered
     * against a directory (DOR-1901), the `.agents/skills` watcher, its
     * 10-second comparison sweep, and the turn-end re-projection. Defaults to
     * `true`; set `false` to manage projection manually via
     * `dorkos harness sync`, which keeps working either way.
     */
    autoSync: z.boolean().default(true),
    /**
     * Whether DorkOS may move a skill out of an agent tool's own folder and
     * into `.agents/skills`, where every agent tool reads it, on its own.
     *
     * Off everywhere by default, and acted on ONLY inside the folders DorkOS
     * owns — an agent's own workspace under `<dorkHome>/agents`, and a room
     * worktree. Everywhere else a move is a person's decision, made with
     * `dorkos harness adopt <name>`, because it is one-way: five agent tools
     * read `.agents/skills` the moment the folder lands there and nothing can
     * un-share it.
     *
     * When it is on, the guard is an ALLOWLIST, not a denylist: only a skill
     * whose settings hold nothing outside the agentskills.io base fields and
     * whose text carries no `${CLAUDE_…}` token is moved. Everything else is
     * reported and left alone, so a field a vendor adds tomorrow fails closed
     * (contract §16 D3).
     */
    autoAdopt: z.boolean().default(false),
    /**
     * The hook projections a person has allowed: installed packages that may
     * write shell commands into the files a coding agent runs on their behalf
     * (`.claude/settings.local.json`, `.codex/hooks.json`, and the rest).
     *
     * Each entry is `<packageName>@<digest>`, where the digest covers the
     * project and the exact commands that were shown on the approval card
     * (`services/harness/hook-approval.ts`). Binding the digest rather than the
     * name alone is what makes an update that changes a package's commands ask
     * again instead of riding an old yes. Empty by default: nothing writes a
     * hook until somebody says so.
     */
    approvedHooks: z.array(z.string()).default(() => []),
    /**
     * The hook projections a person has turned down, in exactly the same
     * `<packageName>@<digest>` form as {@link approvedHooks} — one store, one
     * digest, and an entry never in both.
     *
     * A refusal lasts because there is now a way back out of it:
     * `dorkos harness hooks --list` shows every stored decision and
     * `--revoke <package>` removes one. It also expires on its own — the
     * digest covers the exact commands, so a package that changes what it
     * wants to run stops matching and is asked about again.
     */
    refusedHooks: z.array(z.string()).default(() => []),
    /**
     * The state of each agent's own folder settings a person let run
     * (DOR-3068): its hooks and MCP choices in `.claude/settings*.json`, its
     * `.mcp.json`, and its agent file's MCP servers and account. Each entry is
     * `<agentId>@folder-config-<digest>`, where the digest covers the agent's
     * home and those three parts, so a change the agent makes waits for a person
     * instead of riding an old yes. An agent with no entry is pinned to what its
     * folder holds the first time it runs. Empty by default.
     */
    approvedFolderConfig: z.array(z.string().min(1)).default(() => []),
    /**
     * The per-part digests behind each agent's yes in
     * {@link approvedFolderConfig}, by agent id, so a card can say which part
     * changed. Read only while a stored yes still digests to them.
     */
    approvedFolderConfigParts: z
      .record(
        z.string(),
        z.object({ hooks: z.string(), mcpJson: z.string(), manifest: z.string() })
      )
      .default(() => ({})),
    /**
     * The states a person turned down, in the same form as
     * {@link approvedFolderConfig}. Not asked about again until the settings
     * change again.
     */
    refusedFolderConfig: z.array(z.string().min(1)).default(() => []),
    /**
     * The two decisions global scope records: which agent tools DorkOS shares
     * your globally installed packages with, and when it last asked.
     *
     * A project's enabled agent tools come from `.agents/harness.manifest.json`.
     * Global scope has no repository, so its answer lives here — the same store,
     * the same reader and the same migration chain as the hook decisions beside
     * it, which are the same kind of decision. A second manifest file at
     * `<dorkHome>/harness.manifest.json` would need its own scaffold policy, its
     * own answer to a file that will not parse, and its own version of ADR-0302's
     * "the engine never rewrites a hand-authored file" rule; `.agents/harness.manifest.json`
     * earns all of that by being committed and shared, and nothing at global
     * scope is either.
     */
    global: z
      .object({
        /**
         * The agent tools DorkOS shares your globally installed packages with.
         *
         * Empty means none, which is where a fresh install sits until somebody
         * answers the one-time question `dorkos harness sync --global` asks.
         * There is no separate on/off flag: an empty list IS off, so the two
         * can never disagree.
         */
        harnesses: z.array(z.enum(HARNESS_IDS)).default(() => []),
        /**
         * When the question was answered, ISO-8601. `null` means it has never
         * been asked, which is a different state from asked-and-declined:
         * declined is a timestamp with an empty list, and it is remembered.
         */
        askedAt: z.string().nullable().default(null),
      })
      .default(() => ({ harnesses: [], askedAt: null })),
  })
  .default(() => ({
    autoSync: true,
    autoAdopt: false,
    approvedHooks: [],
    refusedHooks: [],
    approvedFolderConfig: [],
    approvedFolderConfigParts: {},
    refusedFolderConfig: [],
    global: { harnesses: [], askedAt: null },
  }));

/** The `workbench` section of `UserConfigSchema`; its documentation sits on the field there. */
export const WorkbenchConfigSchema = z
  .object({
    /**
     * Overrides for the mime→viewer registry: maps a file extension (with or
     * without a leading dot, any case) to the canvas viewer that opens it,
     * taking precedence over the built-in defaults. Lets an operator, e.g.,
     * open `.csv` files in the plain text editor instead of the table viewer
     * without a code change (workbench D7). Empty by default.
     */
    defaultViewers: z
      .record(
        z.string(),
        z.enum(['file', 'markdown', 'image', 'pdf', 'model3d', 'audio', 'video', 'csv'])
      )
      .default(() => ({})),
    /**
     * Grace period, in minutes, that a detached embedded-terminal PTY is kept
     * alive after its last socket disconnects, so a page refresh can re-attach
     * to the live shell instead of orphaning it (DOR-225). Output produced
     * while detached is buffered and replayed on the next attach; once the
     * window lapses with no re-attach, the PTY is reclaimed. Default 10.
     */
    terminalGraceTtlMinutes: z.number().int().min(1).max(120).default(10),
    /**
     * Whether DorkOS auto-opens a diff document in the workbench when the
     * attached session's agent edits a file (DOR-212). On by default so the
     * operator sees what changed without asking; set `false` to keep the canvas
     * on whatever the operator last opened (the agent can still surface a diff
     * deliberately via the `open_diff` UI command).
     */
    autoOpenDiff: z.boolean().default(true),
  })
  .default(() => ({ defaultViewers: {}, terminalGraceTtlMinutes: 10, autoOpenDiff: true }));
