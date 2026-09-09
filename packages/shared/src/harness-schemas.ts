import { z } from 'zod';

/**
 * The harness vocabulary — the ids and display names of every agent harness
 * Harness Sync knows about.
 *
 * This lives in `@dorkos/shared` rather than in `@dorkos/harness` because the
 * client needs `HarnessId` and `HARNESS_LABELS` to draw a chip row, and it
 * cannot import `@dorkos/harness`, which is a Node filesystem engine.
 * `@dorkos/harness` re-exports all four names from here (`src/manifest/schema.ts`)
 * so every existing import keeps working and there is exactly one definition.
 */

/**
 * The agent harnesses Harness Sync can project to. Claude Code is the canonical
 * authoring harness; the rest are projection targets.
 */
export const HARNESS_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'opencode',
] as const;

/** Zod schema for a single harness identifier (one of {@link HARNESS_IDS}). */
export const HarnessIdSchema = z.enum(HARNESS_IDS);

/** A supported agent harness identifier. */
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/**
 * How each harness is named in prose a person reads — drop reasons, projection
 * notes, warnings.
 *
 * The id is the key in a manifest and a CLI flag; it is not the product's name.
 * `gemini` is Gemini CLI, `claude-code` is Claude Code. One map, so a reason
 * built in the projector and one built in the installed-plugin projector call
 * the same harness the same thing.
 */
export const HARNESS_LABELS: Readonly<Record<HarnessId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};

/**
 * The harness each agent runtime DorkOS can run reads its own files through.
 *
 * DorkOS runs agents; the agents read instructions and skills through a harness.
 * `claude-code` the RUNTIME starts Claude Code, which reads `.claude/`; so a
 * project DorkOS manages has to enable `claude-code` the HARNESS or the session
 * DorkOS starts there never sees the project's `AGENTS.md` (DOR-1901). The two
 * vocabularies happen to share three spellings, which is exactly why the mapping
 * is written down rather than assumed: nothing guarantees the next runtime's id
 * is a harness id, and a runtime with no harness of its own is a real answer.
 *
 * `null` means "this runtime reads no harness's files", not "unknown". Today
 * only `test-mode` is that — it is the e2e fake, it reads nothing off disk, and
 * enabling a harness for it would write files for an agent that cannot read
 * them. An id absent from this table is unknown, and the two are kept apart so a
 * runtime added without a decision here is a gap somebody can find:
 * `apps/server/src/services/harness/__tests__/runtime-harness-table.test.ts`
 * walks the runtimes this repo actually ships and fails on one this table does
 * not name.
 */
export const RUNTIME_HARNESSES: Readonly<Record<string, HarnessId | null>> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  'test-mode': null,
};

/**
 * The harness a runtime reads its files through, or `undefined` when it reads
 * none — either because the runtime has no harness (`test-mode`) or because
 * DorkOS has never heard of it.
 *
 * Both collapse to `undefined` on purpose at the CALL site: every caller does
 * the same thing with them, which is to enable nothing extra. The distinction
 * lives in {@link RUNTIME_HARNESSES}, where it is a decision rather than a
 * branch.
 *
 * @param runtime - A runtime type id, e.g. the stored `runtimes.default`.
 * @returns The harness that runtime reads, or `undefined`.
 */
export function harnessForRuntime(runtime: string): HarnessId | undefined {
  return RUNTIME_HARNESSES[runtime] ?? undefined;
}

/**
 * What one cell of the status grid says — an artifact paired with one enabled
 * harness.
 *
 * Seven values, in the precedence the derivation applies them:
 * `conflict` > `pending-approval` > `drifted` > `dropped` > `native` /
 * `projected` > `warned`. `unmanaged` is deliberately absent: it is a fact about
 * the FILE, not about one harness, so it rides the row as `adoptable` instead of
 * being drawn once per column.
 */
export const HarnessCellStateSchema = z.enum([
  'native',
  'projected',
  'drifted',
  'dropped',
  'warned',
  'conflict',
  'pending-approval',
]);

/** What one cell of the status grid says about one artifact in one harness. */
export type HarnessCellState = z.infer<typeof HarnessCellStateSchema>;

/**
 * What kind of agent file a row is about. Mirrors the projection engine's
 * `ArtifactType`, restated here because `@dorkos/shared` cannot import the
 * engine — the edge runs the other way.
 *
 * The first eight are held together with the engine's list by a
 * `satisfies Record<ArtifactType, …>` mapping table in the server's status
 * model, so adding a kind to the engine is a compile error here rather than a
 * silently missing row.
 *
 * `manifest` is the ninth and has no engine counterpart, deliberately. It exists
 * for the project-level `notice` entries (DOR-1906), which are about
 * `.agents/harness.manifest.json` ITSELF — a retired key, or a hook policy
 * naming a tool the manifest does not enable. The engine plans no artifact for
 * that file, and none of the other eight is it: filing a manifest notice under
 * `instruction` or `plugin` would say it is about a file that is not the one
 * with the problem.
 */
export const HarnessArtifactKindSchema = z.enum([
  'skill',
  'instruction',
  'hook',
  'command',
  'plugin',
  'agent',
  'rule',
  'mcp',
  'manifest',
]);

/** The kind of agent file one status row is about. */
export type HarnessArtifactKind = z.infer<typeof HarnessArtifactKindSchema>;

/**
 * Where the file a row is about came from.
 *
 * `harness-native` is this model's fourth value and the engine has three: it
 * marks a skill authored in a harness's own directory (`.claude/skills`) rather
 * than in the canonical layer, which is the whole subject of the adoptable
 * advice. `adopted` never occurs in v1 — nothing produces an adopted projection
 * yet — and it stays in the enum because the engine's `Provenance` has it and
 * dropping it would make the mapping table lie.
 */
export const HarnessProvenanceSchema = z.enum([
  'authored',
  'installed',
  'adopted',
  'harness-native',
]);

/** Where the file one status row is about came from. */
export type HarnessProvenance = z.infer<typeof HarnessProvenanceSchema>;

/**
 * One artifact's state in one harness, with the sentence that explains it.
 *
 * `reason` is the projection plan's own string, never a paraphrase: the CLI
 * prints the same words, and two surfaces describing one fact in two voices is
 * how a person stops trusting either. `warnings` rides a cell that already has a
 * state — a projection that landed but may not work — while a warning with no
 * cell of its own becomes `state: 'warned'` instead.
 */
export const HarnessCellSchema = z.object({
  state: HarnessCellStateSchema,
  reason: z.string().optional(),
  target: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

/** One artifact's state in one harness. */
export type HarnessCell = z.infer<typeof HarnessCellSchema>;

/**
 * One agent file, and what every enabled harness does with it.
 *
 * The row key is `(artifact, source, name)` and all three are load-bearing:
 * two settings files both contribute a hook group named `hooks`, two MCP servers
 * share one `.mcp.json`, and a skill and a hook declared in that skill's own
 * frontmatter share a source while being different things.
 *
 * `cells` is keyed by harness and holds one entry per ENABLED harness, so it is
 * a partial record over the six ids rather than a complete one.
 */
export const HarnessRowSchema = z.object({
  artifact: HarnessArtifactKindSchema,
  provenance: HarnessProvenanceSchema,
  name: z.string(),
  source: z.string().optional(),
  adoptable: z.boolean(),
  cells: z.partialRecord(HarnessIdSchema, HarnessCellSchema),
});

/** One agent file, and what every enabled harness does with it. */
export type HarnessRow = z.infer<typeof HarnessRowSchema>;

/**
 * An entry that is about the project rather than about any one agent tool.
 *
 * Four shapes, and `kind` says which. A `drop` is something that has no home
 * anywhere — a marketplace package that is not portable to anything. A `warning`
 * is a loss: a file the engine read and could not use, before any tool was
 * considered. A `write` is a file a sync WILL create that belongs to no single
 * tool — the canonical `.agents/skills` link, which exists for the directory
 * rather than for one reader — and it is here because it is otherwise invisible:
 * the plan has to name some harness for it, and if that one is not enabled the
 * file appears in no column while a sync creates it anyway. A `notice` is about
 * the manifest itself (DOR-1906): a key the engine retired, or a hook policy
 * naming a tool this manifest does not enable — configuration that looks like
 * configuration and reaches nothing. Its `artifact` is `manifest` and its
 * `reason` is the engine's own sentence, the same one `dorkos harness sync`
 * prints, so the terminal and the screen name one problem one way.
 *
 * None of the four is ever a cell or a row: filing one under a harness would
 * tell somebody who runs Codex alone that Claude Code has a problem.
 */
export const HarnessProjectEntrySchema = z.object({
  kind: z.enum(['drop', 'warning', 'write', 'notice']),
  artifact: HarnessArtifactKindSchema,
  name: z.string(),
  source: z.string().optional(),
  /** Where a `write` lands, repo-relative. Absent for every other kind. */
  target: z.string().optional(),
  reason: z.string(),
});

/** An entry that is about the project rather than about one harness. */
export type HarnessProjectEntry = z.infer<typeof HarnessProjectEntrySchema>;

/**
 * One installed package whose hooks are held back until a person allows them.
 *
 * It carries the package name, the events and how many commands there are — and
 * never the command strings themselves. The approval card is the surface built
 * to show those, with secret redaction, a length cap, escaping and the event
 * said in plain words; reproducing that here would mean reproducing four safety
 * properties in a second place, and it is what keeps file content off this
 * response entirely.
 */
export const HarnessPendingApprovalSchema = z.object({
  packageName: z.string(),
  events: z.array(z.string()),
  commandCount: z.number().int().nonnegative(),
  reason: z.enum(['unasked', 'refused', 'unreadable-config']),
  detail: z.string().optional(),
});

/** One installed package whose hooks are held back until a person allows them. */
export type HarnessPendingApproval = z.infer<typeof HarnessPendingApprovalSchema>;

/**
 * One path a sync removes, and the one sentence saying why (DOR-1906).
 *
 * The six sweeps take files for five different reasons — the skill a link
 * pointed at is gone, the package that brought a skill or a command is
 * uninstalled, nothing projects hooks at a generated path any more, a
 * half-written file an interrupted sync left behind — and a heading over the
 * list can only say one of them. So the reason rides each path.
 *
 * `reason` is the ENGINE's own sentence (`apply/sweep-reasons.ts`), never a
 * paraphrase, exactly like every cell reason: `dorkos harness sync` prints the
 * same words, and two surfaces describing one deletion in two voices is how a
 * person stops trusting either.
 *
 * One entry is not a deletion at all — `.claude/settings.local.json` keeps every
 * key the person owns and loses only the hook entries DorkOS merged in — and
 * its reason is what says so.
 */
export const HarnessRemovalSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

/** One path a sync removes, and why. */
export type HarnessRemoval = z.infer<typeof HarnessRemovalSchema>;

/**
 * A harness this project does not enable that something says it should.
 *
 * Two things can say so, and they are different claims about different
 * evidence, so `why` says which and the surfaces word the line differently:
 *
 * - `footprint` — the harness's OWN files are in the folder (`.cursor/`), and
 *   `signal` is the repo-relative path that gave it away (contract TR-11).
 * - `dorkos-runtime` — DorkOS's own default runtime reads this harness, so
 *   every session DorkOS starts here reads whatever that harness reads. There
 *   is no path to name, so `signal` is absent (DOR-1901).
 *
 * Neither is an error: a person who runs Cursor on a different project is not
 * wrong. Both are notices with the one command that turns the harness on.
 */
export const NotEnabledHarnessSchema = z.object({
  harness: HarnessIdSchema,
  why: z.enum(['footprint', 'dorkos-runtime']),
  /** The repo-relative path that gave a `footprint` away. Absent otherwise. */
  signal: z.string().optional(),
});

/** A harness this project does not enable that something says it should. */
export type NotEnabledHarness = z.infer<typeof NotEnabledHarnessSchema>;

/**
 * The one query a status read carries.
 *
 * It lives beside the response rather than in the route because the route is
 * not its only reader: `openapi-registry.ts` documents the same shape, and a
 * hand-written second copy there is a copy that goes stale — the same reasoning,
 * and the same home, as `BrowseDirectoryQuerySchema` and `SearchQuerySchema`.
 *
 * `projectPath` is checked for blankness without being TRIMMED. A path is a byte
 * string the filesystem owns, and quietly editing one a caller sent would answer
 * about a directory they did not ask for.
 */
export const HarnessStatusQuerySchema = z.object({
  projectPath: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'projectPath must not be blank'),
});

/** The one query a status read carries. */
export type HarnessStatusQuery = z.infer<typeof HarnessStatusQuerySchema>;

/**
 * What Claude Code alone has: the plugins a person turned on in Claude Code's
 * own settings, and the root they were read from.
 *
 * The root is always present, because `$CLAUDE_CONFIG_DIR` is inherited and the
 * answer is only checkable if you can see which file it came from — a run
 * started inside an agent session can read a different root than the person's
 * own terminal.
 *
 * "Turned on", never "installed": a plugin with no entry at any scope is not
 * off, because Claude Code's `defaultEnabled` falls back to `true`, and the
 * public half of its state cannot enumerate installs at all. So the fourth state
 * is not computable and nothing here claims it.
 *
 * Nothing in `plugins` may be described as "the same plugin" as a DorkOS
 * package: neither side carries a version to compare, so the strongest true
 * claim is a package of the same name from the same repository.
 */
export const HarnessClaudeOnlySchema = z.object({
  /** The Claude root that was read: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  root: z.string(),
  /** When the read happened, ISO-8601. */
  readAt: z.string(),
  /** Why the read failed, in words. When set, `plugins` is empty and means nothing. */
  unreadable: z.string().optional(),
  /**
   * That the answer may be overridden by a managed settings file.
   *
   * A CONSTANT `true` today, and it is a field rather than a sentence because
   * the surfaces have to render the caveat and the caveat has to be able to stop
   * being universal. Claude Code's managed settings outrank every file DorkOS
   * reads and live where DorkOS is not entitled to look — on macOS under
   * `/Library/Application Support/ClaudeCode/`, root-owned — so there is no
   * machine on which DorkOS can currently say this list is complete. Nothing
   * computes it, nothing may branch on it being `false`, and a reader that finds
   * it `false` one day is reading a build where DorkOS learned to check.
   */
  mayBeOverridden: z.boolean(),
  /** The plugins whose merged value across the readable settings files is `true`. */
  plugins: z.array(
    z.object({
      /** The plugin's name, as Claude Code's settings spell it. */
      name: z.string(),
      /** The marketplace's local name inside Claude Code's settings. */
      marketplace: z.string(),
      /**
       * `owner/name`, when Claude Code's own marketplace list resolved it.
       * Absent means DorkOS cannot say where the plugin came from.
       */
      repo: z.string().optional(),
      /** `project` means on for this repository only, with no entry at user scope. */
      settingsScope: z.enum(['user', 'project']),
      /**
       * Which of the five rungs this plugin came to rest on, or
       * `sources-unreadable`.
       *
       * That last value is not a rung: it says nothing about the plugin and
       * everything about DorkOS, whose own `marketplaces.json` could not be
       * read, so no offer can be made about anything. `sourcesUnreadable` on the
       * envelope carries the path and the surface says it once.
       */
      offer: z.enum([
        'install',
        'add-source-then-install',
        'unknown-source',
        'no-package',
        'sources-unreadable',
      ]),
      /** The source URL to add, for `add-source-then-install` only. */
      sourceUrl: z.string().optional(),
    })
  ),
  /** How many hook commands the personal settings file declares. */
  personalHookCommands: z.number().int().nonnegative(),
  /**
   * Keys of the settings file whose own shape defeated DorkOS's walk, while the
   * rest of the file read fine.
   *
   * `enabledPlugins` is never in here: it is the key this whole answer is about,
   * so a shape DorkOS cannot walk there is the envelope's `unreadable` record
   * instead. These two are side facts, and one bad byte in either must not cost
   * a person the plugin list they came for.
   */
  unreadableParts: z.array(z.enum(['extraKnownMarketplaces', 'hooks'])),
  /**
   * How many `enabledPlugins` entries were skipped for not holding a boolean.
   *
   * Absent means none were. Present means the list below is short by that many,
   * which is a thing a person has to be told rather than left to notice.
   */
  skippedEntries: z.number().int().nonnegative().optional(),
  /**
   * The path to DorkOS's OWN source list, when that is what could not be read.
   *
   * Different from `unreadable`, which is about Claude Code's file: here the
   * plugins are known and their repositories are known, and the only thing
   * missing is DorkOS's ability to offer anything about them. Every plugin's
   * `offer` is `sources-unreadable` when this is set.
   */
  sourcesUnreadable: z.string().optional(),
});

/** What Claude Code alone has. @see {@link HarnessClaudeOnlySchema} */
export type HarnessClaudeOnly = z.infer<typeof HarnessClaudeOnlySchema>;

/** One plugin Claude Code alone has. @see {@link HarnessClaudeOnlySchema} */
export type HarnessClaudeOnlyPlugin = HarnessClaudeOnly['plugins'][number];

/**
 * The one field a sync carries — the same rule, and the same non-trimming, as
 * the status query beside it.
 *
 * It lives here rather than in the route for the reason the query does: the
 * route is not its only reader, `openapi-registry.ts` documents the same shape,
 * and a hand-written second copy there is a copy that goes stale.
 */
export const HarnessSyncBodySchema = z.object({
  projectPath: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, 'projectPath must not be blank'),
});

/** The one field a sync carries. */
export type HarnessSyncBody = z.infer<typeof HarnessSyncBodySchema>;

/**
 * What one project's agent-file sharing looks like right now.
 *
 * Three fields carry contracts rather than shapes, and each is stated where it
 * is defined below: `counts.skills` counts ROWS, `sweepPreview` is an equality
 * with what a sync would delete, and there is no `drops` map because every
 * non-agnostic drop is already a cell of some row.
 *
 * On any `state` but `ready` only `projectPath`, `state` and `detail` are
 * meaningful: every list is empty and every count is zero.
 */
export const HarnessStatusResponseSchema = z.object({
  projectPath: z.string(),
  state: z.enum(['ready', 'not-set-up', 'unreadable', 'unavailable']),
  detail: z.string().optional(),
  computedAt: z.string(),
  enabled: z.array(HarnessIdSchema),
  notEnabled: z.array(NotEnabledHarnessSchema),
  clean: z.boolean(),
  counts: z.object({
    /**
     * Rows whose `artifact` is `skill` — a count of ROWS, not of inventory
     * entries. A skill present in both `.agents/skills` and `.claude/skills` is
     * two files, two rows, and counts twice, because the number under the
     * profile row has to match the number of rows the page draws. Measured: 6 on
     * the J-01 fixture, 31 on this repository.
     */
    skills: z.number().int().nonnegative(),
    drifted: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    orphans: z.number().int().nonnegative(),
    adoptable: z.number().int().nonnegative(),
    pendingApproval: z.number().int().nonnegative(),
  }),
  /**
   * Every path a sync would delete — repo-relative, sorted, de-duplicated.
   *
   * The contract is EQUALITY with the `swept` list the next sync returns, never
   * containment: "most of what will be deleted" is a warning with a hole in it,
   * and the hole is where the surprise lives. It is the union of all six sweeps,
   * which is what the engine was widened to be able to answer.
   */
  sweepPreview: z.array(z.string()),
  /**
   * The same paths as {@link HarnessStatusResponseSchema}'s `sweepPreview`, in
   * the same order, each with the reason it would go.
   *
   * Both are here because they have different readers and both are load-bearing:
   * `sweepPreview` is the set the equality contract with the next `swept` is
   * written against, and this is what a person is shown before they click. The
   * page renders these; nothing renders a bare path with no reason beside it.
   */
  removals: z.array(HarnessRemovalSchema),
  rows: z.array(HarnessRowSchema),
  projectLevel: z.array(HarnessProjectEntrySchema),
  pendingApproval: z.array(HarnessPendingApprovalSchema),
  /**
   * What Claude Code alone has, when the answering surface could read it.
   *
   * OPTIONAL, and the optionality is a fact about the model rather than a
   * courtesy. {@link HarnessClaudeOnlySchema} describes a read of somebody's
   * HOME directory, and the status model is a pure function of the inputs it is
   * handed — it never resolves a Claude root, so it never produces this field.
   * Only a surface that reads the machine adds it: `GET /api/harness/status`
   * does, and the Obsidian transport, which answers `state: 'unavailable'` and
   * has no home directory to read, does not.
   */
  claudeOnly: HarnessClaudeOnlySchema.optional(),
});

/**
 * What one project's agent-file sharing looks like right now.
 *
 * There is deliberately no `drops` map beside `rows`: every non-agnostic drop is
 * already a cell of some row, so a map is the same facts twice — measured at
 * 46,244 bytes against 32,415 for this repository. The panels group `rows` on
 * the client instead. `projectLevel` stays, because a harness-agnostic entry is
 * a cell of nothing.
 */
export type HarnessStatusResponse = z.infer<typeof HarnessStatusResponseSchema>;

/**
 * What a sync did, and the status recomputed after it.
 *
 * `swept` is what was actually deleted and equals the `sweepPreview` the page
 * showed before the click; `removals` is that same list with the reason each
 * path went, which is what the "what changed" summary draws. `askedAbout` names
 * the packages a person was shown an approval card for, so the page can say a
 * decision is still outstanding.
 */
export const HarnessSyncResponseSchema = z.object({
  status: HarnessStatusResponseSchema,
  applied: z.number().int().nonnegative(),
  swept: z.array(z.string()),
  removals: z.array(HarnessRemovalSchema),
  conflicts: z.number().int().nonnegative(),
  askedAbout: z.array(z.string()),
});

/** What a sync did, and the status recomputed after it. */
export type HarnessSyncResponse = z.infer<typeof HarnessSyncResponseSchema>;
