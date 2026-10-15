/**
 * Sidebar preferences: item references, groups, smart-group rules and sections.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/sidebar
 */
import { z } from 'zod';

/**
 * A section's per-agent display filter (agent-list-settings, DOR-339): `all`
 * shows every member (inactive ones collapse behind a reveal row), `active`
 * keeps only agents that need attention or are active, `attention` narrows to
 * agents that need attention. Mirrors {@link AttentionState} in
 * `entities/session/model/status/agent-attention.ts` minus `idle`/`inactive`, which
 * never have their own filter value — they are what filtering hides.
 */
export const SidebarDisplayFilterSchema = z.enum(['all', 'active', 'attention']);

/** A section's display filter value (see {@link SidebarDisplayFilterSchema}). */
export type SidebarDisplayFilter = z.infer<typeof SidebarDisplayFilterSchema>;

/**
 * A reference to one thing the sidebar can organize (sidebar-groups, DOR-579).
 *
 * A discriminated union rather than a `"agent:<path>"` string for two reasons:
 * stringly-typed keys are banned outright (`.claude/rules/conventions.md`), and
 * an agent `projectPath` can legally contain a colon on macOS and Linux, so any
 * prefixed-string scheme needs a parse-on-first-colon rule that reads fine and
 * breaks on the one path that has one.
 *
 * Rooms are referenced by ULID because a room has no `projectPath`. Sessions are
 * deliberately not a member kind — see `specs/sidebar-groups/01-ideation.md`.
 */
export const SidebarItemRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), path: z.string().min(1) }),
  z.object({ kind: z.literal('room'), roomId: z.string().min(1) }),
]);

/** A reference to one sidebar-organizable item (see {@link SidebarItemRefSchema}). */
export type SidebarItemRef = z.infer<typeof SidebarItemRefSchema>;
/**
 * Whether two sidebar item references point at the same thing.
 *
 * A discriminated union has no structural identity, so every membership test
 * over `pinned` / `muted` / `groups[].items` needs this — `includes`,
 * `indexOf` and `===` all compare by object reference and would silently miss.
 * Do NOT substitute a `JSON.stringify` comparison: key order is not guaranteed
 * across the code paths that construct these.
 *
 * @param a - First reference.
 * @param b - Second reference.
 * @returns `true` when both name the same agent path or the same room id.
 */
export function sameSidebarItem(a: SidebarItemRef, b: SidebarItemRef): boolean {
  if (a.kind === 'agent') return b.kind === 'agent' && a.path === b.path;
  return b.kind === 'room' && a.roomId === b.roomId;
}

/**
 * A smart group's membership rule set (smart-agent-groups, DOR-338). Every
 * PRESENT field is an AND constraint; within a field, values are OR'd (e.g.
 * `runtimes: ['codex', 'opencode']` matches either). An absent field imposes
 * no constraint. Evaluated by `evaluateSmartGroup` in `@dorkos/shared/smart-groups` — never
 * persisted as materialized membership.
 */
export const SmartGroupRulesSchema = z.object({
  /** Match any of these runtimes (OR). Absent field = no constraint. */
  runtimes: z.array(z.string()).optional(),
  /** Match any of these mesh namespaces (OR). */
  namespaces: z.array(z.string()).optional(),
  /** Match any of these attention states (OR). Mirrors `AttentionState`. */
  statuses: z.array(z.enum(['needs-attention', 'active', 'idle', 'fresh', 'inactive'])).optional(),
  /** Activity within this window (ms), inclusive at the boundary. */
  lastActiveWithinMs: z.number().int().positive().optional(),
  /** `projectPath` starts-with match. */
  pathPrefix: z.string().min(1).optional(),
});

/** A smart group's rule set (see {@link SmartGroupRulesSchema}). */
export type SmartGroupRules = z.infer<typeof SmartGroupRulesSchema>;

const SidebarGroupShapeSchema = z.object({
  /** Stable id, `crypto.randomUUID()` minted client-side at creation. */
  id: z.string().min(1),
  /** Display name. Duplicates allowed (ids disambiguate). */
  name: z.string().trim().min(1).max(40),
  /**
   * Ordered member references - the durable manual order. Ignored when
   * `kind === 'smart'` (membership derives from `rules` instead); kept as-is
   * so "Convert to manual group" has somewhere to materialize into.
   */
  items: z.array(SidebarItemRefSchema).default(() => []),
  /**
   * How rows inside this group are ordered. Switching away from 'manual'
   * never mutates items. Smart groups reject `'manual'` (see the
   * cross-field refine below) — derived membership has no hand-orderable
   * sequence.
   */
  sortMode: z.enum(['manual', 'recent', 'name']).default('manual'),
  collapsed: z.boolean().default(false),
  /** Which members render: all, active-recently, or needs-attention only (DOR-339). */
  displayFilter: SidebarDisplayFilterSchema.default('all'),
  /** Muted groups drop every attention signal for all members at once (DOR-339). */
  muted: z.boolean().default(false),
  /**
   * Manual groups own `items`; smart groups derive membership from `rules`
   * (smart-agent-groups, DOR-338). Additive discriminator — existing groups
   * default `'manual'`, zero migration risk.
   */
  kind: z.enum(['manual', 'smart']).default('manual'),
  /** Present iff `kind === 'smart'`. At least one field must be set (refine below). */
  rules: SmartGroupRulesSchema.optional(),
});

/**
 * A single user-defined sidebar group (Slack-style section), with the
 * DOR-338 cross-field invariants a plain object shape can't express:
 * a `'smart'` group must carry at least one rule constraint, and smart
 * groups can never use `sortMode: 'manual'` (derived membership has no
 * hand-orderable sequence — the group-create flow forces `'recent'`, and the
 * render path falls back `manual → recent` defensively for any data that
 * somehow predates this constraint).
 */
export const SidebarGroupSchema = SidebarGroupShapeSchema.superRefine((group, ctx) => {
  if (group.kind !== 'smart') return;
  if (!group.rules || Object.keys(group.rules).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rules'],
      message: 'A smart group requires at least one rule constraint.',
    });
  }
  if (group.sortMode === 'manual') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sortMode'],
      message:
        "Smart groups can't use 'manual' sort — membership is rule-derived, not hand-orderable.",
    });
  }
});

/** A single user-defined sidebar group (Slack-style section). */
export type SidebarGroup = z.infer<typeof SidebarGroupSchema>;

/**
 * Every sidebar section that can remember something about itself.
 *
 * The four the redesign keeps are `pins`, `channels`, `dms` and `agents` — the
 * Library's sections in render order (`specs/sidebar-now-today-library`, BC-28).
 * `threads` and `recents` are here because their sections still render while the
 * redesign lands, and dropping their ids would mean throwing away a collapse
 * state the person set. They go when the sections that read them do; nothing new
 * should start using them.
 *
 * `now`, `today` and `getting-started` are here because every header folds now —
 * one rule instead of an exception (`specs/sidebar-simplification` D1,
 * superseding BC-2's "a zone never collapses"). They are the computed zones'
 * single bodies, so folding one folds the zone; the id is the zone's own id, so
 * nothing has to translate.
 *
 * `addons` is the Library section that lists the pages mini apps add (spec
 * `mini-app-placement` Part 2). It holds a fold flag and nothing else.
 *
 * **Widening this enum is a non-event, and that is by construction.** The
 * `dropUnknownSectionIds` preprocessor below strips any key a build does not
 * recognise, so a config written by a newer DorkOS loads on an older one — it
 * loses a fold flag rather than becoming permanently unwritable. That property
 * is what makes adding an id here safe with no data migration: nothing already
 * on disk changes shape, and nothing has to be rewritten.
 */
export const SidebarSectionIdSchema = z.enum([
  'now',
  'today',
  'getting-started',
  'pins',
  'channels',
  'dms',
  'agents',
  'addons',
  'threads',
  'recents',
]);

/** One sidebar section's identity (see {@link SidebarSectionIdSchema}). */
export type SidebarSectionId = z.infer<typeof SidebarSectionIdSchema>;

/**
 * What one section remembers: whether it is folded, and the two display choices
 * a section can offer.
 *
 * `sortMode` and `displayFilter` are optional rather than defaulted because most
 * sections offer neither — an absent value means "this section has no such
 * option", which is a different statement from "the option is set to its
 * default". Agents carries both; Channels and Direct messages carry `sortMode`
 * as of DOR-906, which needed no schema change because this shape has always
 * been per-section rather than per-kind.
 */
export const SidebarSectionPrefsSchema = z.object({
  /** Whether the section is folded shut. */
  collapsed: z.boolean().default(false),
  /** How rows inside the section are ordered, where the section offers a choice. */
  sortMode: z.enum(['manual', 'name', 'recent']).optional(),
  /** Which members render, where the section offers a filter (DOR-339). */
  displayFilter: SidebarDisplayFilterSchema.optional(),
});

/** One section's remembered state (see {@link SidebarSectionPrefsSchema}). */
export type SidebarSectionPrefs = z.infer<typeof SidebarSectionPrefsSchema>;

/** The section ids as a lookup, for the read-time filter below. */
const SIDEBAR_SECTION_IDS = new Set<string>(SidebarSectionIdSchema.options);

/**
 * Drop `sections` entries naming a section this build does not know about.
 *
 * **This is what makes narrowing {@link SidebarSectionIdSchema} a non-event**,
 * and it is not a nicety — without it, retiring a section id later would leave
 * every config that stored one PERMANENTLY UNWRITABLE. Ajv is the only validator
 * on the config read path and the generated schema carries no `propertyNames`,
 * so an unknown key loads fine; Zod then refuses it, and `applyConfigPatch`
 * re-validates the WHOLE config on every write. The result is a config that
 * boots, is never condemned, and rejects every subsequent settings change with
 * `Invalid key in record`. Proven end to end before this filter existed.
 *
 * `threads` and `recents` are the ids this will actually catch: they exist only
 * while the pre-redesign sections still render, and P2 removes them. Anyone who
 * had those sections folded simply loses two collapse states that no longer
 * address anything — which is the correct outcome, and it needs no second
 * migration to bring about.
 *
 * Preserves identity when there is nothing to drop, and passes a non-object
 * through untouched so the record schema below reports the real type error
 * rather than this filter swallowing it.
 *
 * @param value - The stored `sections` value, in whatever shape it is on disk.
 * @returns The same value, minus any key that is not a known section id.
 */
function dropUnknownSectionIds(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const known = entries.filter(([id]) => SIDEBAR_SECTION_IDS.has(id));
  return known.length === entries.length ? value : Object.fromEntries(known);
}

/**
 * Per-section state, keyed by section id, tolerant of ids it has never heard of
 * (see {@link dropUnknownSectionIds}).
 */
const SidebarSectionsSchema = z.preprocess(
  dropUnknownSectionIds,
  z.partialRecord(SidebarSectionIdSchema, SidebarSectionPrefsSchema)
);

export const SidebarPrefsSchema = z.object({
  /** Ordered pinned item references. Multi-presence references - membership in groups is unaffected. */
  pinned: z.array(SidebarItemRefSchema).default(() => []),
  groups: z.array(SidebarGroupSchema).default(() => []),
  /**
   * Per-section state, keyed by section id. A section with nothing to remember
   * is simply absent, so a fresh install stores `{}` rather than a row of
   * `false`s — which is also why this is a partial record: adding a section id
   * must never invalidate a config written before it existed, and
   * {@link dropUnknownSectionIds} makes REMOVING one equally harmless.
   *
   * Replaced the seven per-section booleans and enums this schema used to carry
   * (`ungroupedCollapsed`, `channelsCollapsed`, `dmsCollapsed`,
   * `threadsCollapsed`, `recentsCollapsed`, `ungroupedSortMode`,
   * `ungroupedDisplayFilter`); the conf migration keyed `0.59.0` moves them.
   */
  sections: SidebarSectionsSchema.default(() => ({})),
  /**
   * Muted item references (DOR-339). Mute owns ALL attention signals for an
   * item at once (badge, rollup-dot contribution, filter/reveal emphasis); no
   * partial mute states.
   */
  muted: z.array(SidebarItemRefSchema).default(() => []),
  /**
   * The Getting started zone's memory: which suggestions this person has
   * finished with, so a suggestion never comes back once it has been retired —
   * even if the condition that raised it becomes true again (BC-14).
   *
   * Ids are plain strings rather than an enum on purpose. The list outlives the
   * suggestions in it: `'suggestion:groups-hint'` is a retired card the
   * migration carries forward, and narrowing the type would make a stored
   * history invalid every time the suggestion set changed.
   */
  gettingStarted: z
    .object({ retired: z.array(z.string()).default(() => []) })
    .default(() => ({ retired: [] })),
  /**
   * The welcome-back digest's memory: the local date (`YYYY-MM-DD`) it was last
   * shown on, so it appears at most once a day (BC-22). Absent until the first
   * digest is shown; written by the client's `markDigestShown` the moment the
   * row renders. Server-held rather than local, so the moment is once per day
   * per account and not once per device.
   */
  digest: z.object({ lastShownDate: z.string().optional() }).default(() => ({})),
});

/** Server-persisted sidebar organization preferences (`ui.sidebar`). */
export type SidebarPrefs = z.infer<typeof SidebarPrefsSchema>;

/**
 * Fully-defaulted {@link SidebarPrefs}. Parsed once from an empty object so the
 * config route and the client selector share one canonical default (the sidebar
 * always renders even before the first user write).
 */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = SidebarPrefsSchema.parse({});
