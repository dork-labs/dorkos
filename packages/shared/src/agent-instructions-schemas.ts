/**
 * The wire shape of the agent context viewer (spec `context-viewer` phase 3):
 * what every agent is told, as a template, and what one agent will be told.
 *
 * Both views come from the server's own prompt builders, split into the blocks
 * they wrote. Nothing here carries recorded turn text: that is phase 1's
 * record, which is the person's alone (Security ruling 4).
 *
 * @module shared/agent-instructions-schemas
 */
import { z } from 'zod';

/** The runtimes the viewer can show. */
export const InstructionsRuntimeSchema = z.enum(['claude-code', 'codex', 'opencode', 'doe']);

/** A runtime the viewer can show. */
export type InstructionsRuntime = z.infer<typeof InstructionsRuntimeSchema>;

/** Where the turn happens: a direct chat, a room, or a scheduled task. */
export const InstructionsPlaceSchema = z.enum(['direct', 'room', 'task']);

/** Where the turn happens. */
export type InstructionsPlace = z.infer<typeof InstructionsPlaceSchema>;

/** The agent's level (`PermissionStop`). */
export const InstructionsLevelSchema = z.enum(['ask', 'act', 'autonomy']);

/** The agent's level. */
export type InstructionsLevel = z.infer<typeof InstructionsLevelSchema>;

/** Which list a block rides: the session's append, or this turn's list. */
export const InstructionsLayerSchema = z.enum(['session', 'turn']);

/** Why a block is included. */
export const InstructionsConditionSchema = z.enum([
  'always',
  'agent',
  'setting',
  'rooms',
  'tasks',
  'connection',
  'state',
]);

/** Why a block is included. */
export type InstructionsCondition = z.infer<typeof InstructionsConditionSchema>;

/**
 * How a block reaches the model on this runtime: on every turn, or once per
 * conversation (Codex's stable half, re-sent only when it changes).
 */
export const InstructionsDeliverySchema = z.enum(['every-turn', 'once']);

/** One documented variable a template may carry (Security ruling 3). */
export const InstructionsVariableSchema = z.object({
  /** The token, without braces: `agent.name`. */
  id: z.string(),
  /** What it stands for, in a few words. */
  label: z.string(),
  /**
   * Whether "Preview as…" fills it. Per-turn values (the fence code, a room's
   * files, the agent's memory) stay chips even in a preview.
   */
  fillable: z.boolean(),
});

/** One documented variable. */
export type InstructionsVariable = z.infer<typeof InstructionsVariableSchema>;

/** One block, in model order. */
export const InstructionsBlockSchema = z.object({
  /** Stable id: the block's tag, or a named id for an untagged block. */
  id: z.string(),
  /** A short name a person reads. */
  title: z.string(),
  layer: InstructionsLayerSchema,
  /** The source file or code that writes it. */
  source: z.string(),
  condition: InstructionsConditionSchema,
  /** When it is included, in a few words. */
  conditionNote: z.string(),
  /** Shown only, for everyone (Security ruling 1). */
  locked: z.boolean(),
  /** Where a person changes it today, for an editable block. */
  editIn: z.string().nullable(),
  delivery: InstructionsDeliverySchema,
  /**
   * The text the builders wrote, with `{{variable}}` tokens, or `null` when it
   * is built each turn from live state and has no template to show.
   */
  text: z.string().nullable(),
  /** Variables the text carries. */
  variables: z.array(z.string()),
  /** A rough token count: characters over four. */
  tokens: z.number().int(),
  /**
   * How many agents override this block. Person's view only (Security ruling
   * 8): absent from what an agent reads.
   */
  overrideCount: z.number().int().optional(),
});

/** One block, in model order. */
export type InstructionsBlock = z.infer<typeof InstructionsBlockSchema>;

/** A whole view: template or one agent's preview. */
export const InstructionsViewSchema = z.object({
  mode: z.enum(['template', 'preview']),
  runtime: InstructionsRuntimeSchema,
  place: InstructionsPlaceSchema,
  level: InstructionsLevelSchema,
  /** The previewed agent's id, in preview mode. */
  agentId: z.string().nullable(),
  /** What this runtime adds or does that DorkOS cannot show. */
  runtimeNotes: z.array(z.string()),
  /** What the level changes, in a sentence. */
  levelNote: z.string(),
  /** Blocks the builders wrote for this view, in model order. */
  blocks: z.array(InstructionsBlockSchema),
  /** Blocks that exist but were not included in this view, with why. */
  notIncluded: z.array(InstructionsBlockSchema),
  /** The documented variable set. */
  variables: z.array(InstructionsVariableSchema),
  /** Total rough tokens of `blocks`. */
  tokens: z.number().int(),
});

/** A whole view. */
export type InstructionsView = z.infer<typeof InstructionsViewSchema>;

/** The query both views take. */
export const InstructionsQuerySchema = z.object({
  runtime: InstructionsRuntimeSchema.optional(),
  place: InstructionsPlaceSchema.default('direct'),
  level: InstructionsLevelSchema.default('act'),
});

/** The query both views take. */
export type InstructionsQuery = z.infer<typeof InstructionsQuerySchema>;
