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
  notEnabled: z.array(z.object({ harness: HarnessIdSchema, signal: z.string() })),
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
  rows: z.array(HarnessRowSchema),
  projectLevel: z.array(HarnessProjectEntrySchema),
  pendingApproval: z.array(HarnessPendingApprovalSchema),
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
 * showed before the click. `askedAbout` names the packages a person was shown an
 * approval card for, so the page can say a decision is still outstanding.
 */
export const HarnessSyncResponseSchema = z.object({
  status: HarnessStatusResponseSchema,
  applied: z.number().int().nonnegative(),
  swept: z.array(z.string()),
  conflicts: z.number().int().nonnegative(),
  askedAbout: z.array(z.string()),
});

/** What a sync did, and the status recomputed after it. */
export type HarnessSyncResponse = z.infer<typeof HarnessSyncResponseSchema>;
