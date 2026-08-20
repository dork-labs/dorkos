/**
 * Persistent user-config schema. Zod is authoritative; `ConfigManager` bridges it
 * to `conf` via `z.toJSONSchema`.
 *
 * **Keep this module free of module-level mutable state and of exports whose
 * identity is compared** (`===`, `instanceof`, `Map`/`Set` keys, registry lookups).
 * Zod schemas, derived constants, and pure functions only. `apps/server/vitest.config.ts`
 * aliases this one subpath to source so the config-disclosure drift guard cannot
 * read a stale `dist/`, and because `dist/schemas.js` reaches back here by a
 * relative import that the alias does not rewrite, a test process can hold both
 * the src and the dist copy of this module. Duplicated values are harmless;
 * duplicated state or identity would not be.
 *
 * Adding a field? It also needs a disclosure verdict in `CONFIG_DISCLOSURE`
 * (`apps/server/src/services/core/operator/config-disclosure.ts`) and a `conf`
 * migration. See `contributing/configuration.md`.
 *
 * @module config-schema
 */
import { z } from 'zod';
import { EFFORT_LEVELS } from './constants.js';

/**
 * How long a new standing permission lasts by default, in minutes (eight hours —
 * about one working day, which is the span the button on the approval card names).
 */
export const DEFAULT_TRUST_WINDOW_MINUTES = 480;

/**
 * Shortest standing permission a person can choose, in minutes.
 *
 * A floor keeps the window from becoming a deny-all that looks like a broken
 * feature, which is the reasoning already applied to the approval window in
 * `approval-service.ts`.
 */
export const MIN_TRUST_WINDOW_MINUTES = 5;

/**
 * Longest standing permission a person can choose, in minutes (one day).
 *
 * The ceiling is what makes "forever" unrepresentable. It is a schema bound rather
 * than a UI one, so no surface can offer a window the store would accept.
 */
export const MAX_TRUST_WINDOW_MINUTES = 1440;

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = [
  'tunnel.authtoken',
  'tunnel.auth',
  'mcp.apiKey',
  'cloud.instanceToken',
] as const;

/**
 * Credential-reference schemes recognized by the `CredentialProvider` port
 * (ADR-0315). A stored credential is always one of these references, never a
 * raw secret.
 */
export const CREDENTIAL_SCHEMES = ['keychain', 'env', 'file'] as const;

/** One of the recognized {@link CREDENTIAL_SCHEMES}. */
export type CredentialScheme = (typeof CREDENTIAL_SCHEMES)[number];

/**
 * A credential value stored in config is a REFERENCE, never plaintext:
 * `keychain:<id>` (OS keychain), `env:<VAR>` (process env), or `file:<name>`
 * (encrypted dork-home secret store). The value after the scheme must be
 * non-empty. This pattern is the schema-level guard that keeps raw secrets out
 * of `config.json` — a plaintext key (e.g. `sk-ant-...`) fails validation
 * (ADR-0315, decision: never persist plaintext).
 */
export const CREDENTIAL_REF_PATTERN = /^(?:keychain|env|file):.+/;

/**
 * Zod schema for a single credential reference value. Rejects anything that is
 * not a well-formed `keychain:`/`env:`/`file:` reference — the structural
 * guarantee that a raw secret can never be persisted as a provider value.
 */
export const CredentialReferenceSchema = z
  .string()
  .regex(CREDENTIAL_REF_PATTERN, 'must be a keychain:/env:/file: reference, never a raw secret');

/**
 * Split a credential reference into its `scheme` and `value`, or return `null`
 * when the string is not a well-formed reference (no colon, an unrecognized
 * scheme, or an empty value). The lone parser for the reference grammar — the
 * `CredentialProvider` port and the schema guard share this single definition.
 *
 * @param ref - The stored reference string (e.g. `env:OPENROUTER_API_KEY`).
 */
export function parseCredentialReference(
  ref: string
): { scheme: CredentialScheme; value: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0) return null;
  const scheme = ref.slice(0, idx);
  const value = ref.slice(idx + 1);
  if (value.length === 0) return null;
  if (!(CREDENTIAL_SCHEMES as readonly string[]).includes(scheme)) return null;
  return { scheme: scheme as CredentialScheme, value };
}

/**
 * The guided onboarding steps a first-time user walks through: meeting DorkBot
 * (personality), telling it what kind of work you do (`'profile'`, the role
 * beat from spec `user-profile-onboarding`), and importing projects
 * (`'discovery'`). The former `'tasks'` and `'adapters'` values were retired
 * (task scheduling moved out of onboarding; the adapters step never shipped) — a
 * config migration scrubs them from any persisted `completedSteps`/`skippedSteps`
 * so a narrowed enum never fails to parse an upgraded config. Adding `'profile'`
 * is the opposite move: widening is additive, old stored arrays still parse, and
 * no scrub migration is needed.
 */
export const ONBOARDING_STEPS = ['meet-dorkbot', 'profile', 'discovery'] as const;

export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const OnboardingStateSchema = z.object({
  completedSteps: z.array(OnboardingStepSchema).default(() => []),
  skippedSteps: z.array(OnboardingStepSchema).default(() => []),
  startedAt: z.string().nullable().default(null),
  dismissedAt: z.string().nullable().default(null),
  /**
   * ISO timestamp when the user reached the finish line of the first-run flow
   * (the completion screen). The single authoritative "onboarding is done"
   * signal: once set, the full-screen flow never reappears on refresh. Distinct
   * from `dismissedAt`, which records a deliberate skip/hide of the getting-started
   * helper. Both null means a brand-new install that has not onboarded yet.
   */
  completedAt: z.string().nullable().default(null),
  /**
   * ISO timestamp of the moment first-run setup decided which runtime new
   * conversations start on (`runtimes.default`, spec `execution-defaults` §7).
   *
   * **This field exists to make the decision happen exactly once.** The
   * requirements step can only pick the runtime that is actually ready, and
   * readiness is not a fixed fact — a person connects Codex from a card mid-flow
   * and the answer changes. So the pick has to wait for readiness to settle
   * rather than run at boot, and something has to remember that it ran. It
   * cannot be inferred from `runtimes.default` itself: that field has a default
   * value, so "claude-code" is indistinguishable from a choice somebody made.
   *
   * Non-null means the question is closed forever. Reopening onboarding, a
   * mid-flow refresh, or a later install of another runtime never re-decides —
   * the person owns the setting from that moment on, and Settings → Runtimes is
   * where they change it.
   */
  runtimeDefaultSetAt: z.string().nullable().default(null),
});

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

/**
 * Persisted state for the DorkBot living tour (DOR-419). Tracks which tours the
 * user has already run (`seen`) and which they declined (`declined`) so an
 * occasion never re-offers a tour the user has finished or waved off. Ids are the
 * tour definition ids (`'tasks' | 'relay' | 'mesh' | 'general'`), stored as free
 * strings so adding a tour never needs a schema migration. Managed automatically
 * by the client; not user-editable.
 */
export const ToursStateSchema = z.object({
  seen: z.array(z.string()).default(() => []),
  declined: z.array(z.string()).default(() => []),
});

export type ToursState = z.infer<typeof ToursStateSchema>;

/** Frozen defaults for the {@link ToursStateSchema} block (empty on a fresh install). */
export const TOURS_DEFAULTS: ToursState = ToursStateSchema.parse({});

/**
 * What the user has told DorkOS about themselves (spec `user-profile-onboarding`).
 *
 * **Local-only by tested invariant, not by promise:** the telemetry heartbeat
 * and usage-event payloads are strict allowlists that never carry any of these
 * fields, and sentinel-value exclusion tests keep it that way. The profile is
 * used in exactly two places: a short factual `<user_profile>` block projected
 * into every session's agent context, and the pure role → recommendations
 * mapping in `@dorkos/shared/profile-recommendations`.
 *
 * All four leaves are `expose` + `agent-writable` on purpose: agents knowing
 * and updating the profile IS the feature (DorkBot saves "call me Dorian" or
 * "I also use Figma" via `config_patch` mid-conversation).
 */
export const UserProfileSchema = z.object({
  /** What kind of work the user does. Free-form, but onboarding offers ROLE_CANON. */
  roles: z
    .array(z.string().trim().min(1).max(60))
    .max(10)
    .default(() => []),
  /** Tools/services the user works with (e.g. "Gmail", "Linear"). Not asked in onboarding v1. */
  tools: z
    .array(z.string().trim().min(1).max(60))
    .max(50)
    .default(() => []),
  /** What the user likes to be called. Optional; never required. */
  displayName: z.string().trim().min(1).max(80).nullable().default(null),
  /**
   * ISO timestamp when the one-time existing-user prompt was dismissed
   * ("don't ask again"). Machine-managed; null = never dismissed.
   */
  rolePromptDismissedAt: z.string().nullable().default(null),
});

/** What the user has told DorkOS about themselves (see {@link UserProfileSchema}). */
export type UserProfile = z.infer<typeof UserProfileSchema>;

/** Frozen defaults for the {@link UserProfileSchema} block (empty on a fresh install). */
export const USER_PROFILE_DEFAULTS: UserProfile = UserProfileSchema.parse({});

/**
 * A section's per-agent display filter (agent-list-settings, DOR-339): `all`
 * shows every member (inactive ones collapse behind a reveal row), `active`
 * keeps only agents that need attention or are active, `attention` narrows to
 * agents that need attention. Mirrors {@link AttentionState} in
 * `entities/session/model/agent-attention.ts` minus `idle`/`inactive`, which
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
 * Convert one STORED membership entry into a {@link SidebarItemRef}.
 *
 * A `ui.sidebar` written before DOR-579 holds bare agent `projectPath` strings
 * in `pinned`, `muted` and each group's member list. Rooms did not exist in the
 * sidebar then, so every such string IS an agent path and the mapping is total —
 * there is no value that could be misread.
 *
 * This is the single statement of that rule. Both the read path
 * ({@link normalizeSidebarPrefs}) and the config migration that rewrites the
 * file go through it, so the two can never disagree about what a stored string
 * means.
 *
 * @param entry - A stored entry: either a reference already, or a legacy path.
 * @returns The entry as a reference; an existing reference passes through.
 */
export function toSidebarItemRef(entry: SidebarItemRef | string): SidebarItemRef {
  return typeof entry === 'string' ? { kind: 'agent', path: entry } : entry;
}

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
 * `now` and `today` are here because every header folds now — one rule instead
 * of an exception (`specs/sidebar-simplification` D1, superseding BC-2's "a zone
 * never collapses"). They are the computed zones' single bodies, so folding one
 * folds the zone; the id is the zone's own id, so nothing has to translate.
 *
 * Getting started is deliberately still absent. It is a life stage rather than a
 * place: it disappears the moment there is a real signal to show and retires
 * itself suggestion by suggestion, so a fold flag for it would outlive the thing
 * it addressed and quietly hide the day-one guidance of the NEXT fresh install.
 */
export const SidebarSectionIdSchema = z.enum([
  'now',
  'today',
  'pins',
  'channels',
  'dms',
  'agents',
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
 * default". Only the Agents section carries both today.
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

/**
 * One group as it may actually sit on disk before the DOR-579 migration runs.
 *
 * The declared {@link SidebarGroup} type says `items` is present and holds
 * references. A file written by an earlier release says otherwise, and this
 * type is where that gap is stated out loud instead of being cast away.
 */
interface StoredSidebarGroup extends Omit<SidebarGroup, 'items'> {
  items?: readonly (SidebarItemRef | string)[];
  /** Pre-DOR-579 name for `items`, holding bare agent paths. */
  agentPaths?: readonly string[];
}

/**
 * Convert one stored membership list, preserving identity when there is nothing
 * to convert (so an already-canonical prefs object is returned unchanged).
 */
function normalizeItemList(list: readonly (SidebarItemRef | string)[]): SidebarItemRef[] {
  return list.some((entry) => typeof entry === 'string')
    ? list.map(toSidebarItemRef)
    : (list as SidebarItemRef[]);
}

/**
 * Bring a stored `ui.sidebar` into the canonical shape: every membership entry a
 * {@link SidebarItemRef}, and each group's members under `items`.
 *
 * **Read-time conversion exists so correctness never depends on the migration
 * having run.** `conf` only runs a migration when its key is in
 * `(storedVersion, projectVersion]`, so the DOR-579 rewrite is skipped whenever
 * the app version does not land in that window — most visibly in a dev tree,
 * where the version resolves to `0.0.0` and no migration runs at all. Without
 * this, those installs would read `items` as the schema default `[]` and show
 * empty groups. The migration still runs where it can; it cleans the file up,
 * and this keeps behaviour correct until it does.
 *
 * Returns `stored` itself when it is already canonical, so callers can rely on
 * referential equality to skip work.
 *
 * @param stored - The sidebar prefs as read from config, in either encoding.
 * @returns Canonical prefs.
 */
export function normalizeSidebarPrefs(stored: SidebarPrefs): SidebarPrefs {
  const pinned = normalizeItemList(stored.pinned);
  const muted = normalizeItemList(stored.muted);

  let groupsChanged = false;
  const groups = stored.groups.map((group) => {
    const legacy = group as StoredSidebarGroup;
    // An existing `items` wins over a leftover `agentPaths`: only a file written
    // before DOR-579 carries the old key, so the two can never hold different
    // truths, and preferring `items` keeps a half-migrated file from
    // resurrecting a list the person has since edited.
    const source = legacy.items ?? legacy.agentPaths ?? [];
    const items = normalizeItemList(source);
    if (items === legacy.items && legacy.agentPaths === undefined) return group;
    groupsChanged = true;
    const { agentPaths: _legacyKey, ...rest } = legacy;
    return { ...rest, items } as SidebarGroup;
  });

  if (pinned === stored.pinned && muted === stored.muted && !groupsChanged) return stored;
  return { ...stored, pinned, muted, groups };
}

/**
 * Person-scoped Shape state (`ui.shapes`, DOR-355). Holds the currently-applied
 * Shape, the reverse affinity hints (agent → preferred Shape), and the
 * offer-vs-follow toggle. Kept in user config — never on `.dork/agent.json` —
 * exactly per ADR 260717-001409 (a personal cockpit preference, not an agent
 * property). Whole-object writes per section (deepMerge replaces arrays).
 */
export const ShapeUserPrefsSchema = z.object({
  /** Installed Shape name currently applied, or null. */
  active: z.string().nullable().default(null),
  /**
   * Reverse affinity hint: agent `projectPath` → preferred Shape name. The
   * "soft default hint on an agent" from D2, kept OFF the agent manifest and in
   * person-scoped config, exactly per ADR 260717-001409.
   */
  agentDefaults: z.record(z.string(), z.string()).default(() => ({})),
  /**
   * When true, applying a Shape auto-follows to its `default` agent instead of
   * only offering. Off by default (offer, don't force).
   */
  autoFollowAgent: z.boolean().default(false),
});

/** Person-scoped Shape state (`ui.shapes`). */
export type ShapeUserPrefs = z.infer<typeof ShapeUserPrefsSchema>;

/**
 * Fully-defaulted {@link ShapeUserPrefs}. Parsed once so the config route,
 * the client, and the conf migration share one canonical default.
 */
export const SHAPE_USER_PREFS_DEFAULTS: ShapeUserPrefs = ShapeUserPrefsSchema.parse({});

/**
 * Every status-line item a person is allowed to pin.
 *
 * Deliberately a closed set, not free strings: the list is agent-writable via
 * `config_patch`, and an enum makes the legal values discoverable in the
 * generated JSON/OpenAPI schema and rejects a typo at the boundary instead of
 * persisting it. It mirrors the client registry's *pinnable* items — the Session
 * group minus `cache`. Controls (`sound`, `polling`) are settings rather than
 * status, and diagnostics rows are system-managed, so neither is pinnable; that
 * exclusion is what stops pins from quietly becoming ten visibility toggles
 * again. A client-side drift test keeps this enum and the registry in step.
 *
 * Widening this list is backward compatible — every pin already on disk stays
 * valid — so it needs no migration. Narrowing it would: a stored pin whose key
 * left the enum fails validation, which is why the client ignores an unknown pin
 * downstream rather than rejecting the whole preference.
 */
export const StatusBarPinSchema = z.enum([
  'cwd',
  'git',
  'runtime',
  'model',
  'context',
  'usage',
  'permission',
  'plan',
]);

/** One pinnable status-line item key. */
export type StatusBarPin = z.infer<typeof StatusBarPinSchema>;

/**
 * Every pinnable status-line item key, as a runtime array. Lets the client
 * narrow an arbitrary registry key to a {@link StatusBarPin} without a cast, and
 * gives the registry↔schema drift test something to compare against.
 */
export const STATUS_BAR_PIN_KEYS: readonly StatusBarPin[] = StatusBarPinSchema.options;

/**
 * Person-scoped status-bar preferences (`ui.statusBar`, DOR-431 → DOR-452).
 *
 * The status line is quiet by default: an item appears only when its promotion
 * rule fires (it is actionable or anomalous) or when a person pinned it here.
 * `pins` is therefore additive — it says "always show me this" — where the ten
 * `boolean` visibility toggles this section originally held were subtractive
 * ("hide this"). Pins live in server config rather than client `localStorage` so
 * the choice syncs across devices and an agent can set it via `config_patch`
 * (spec agents-as-operators).
 *
 * A `config_patch` replaces arrays wholesale, so patching `pins` sets the whole
 * list — that is the intended semantics for a list of "keep these".
 */
export const StatusBarPrefsSchema = z.object({
  /** Status-line items to show even when their promotion rule would stay quiet. */
  pins: z.array(StatusBarPinSchema).default([]),
});

/** Person-scoped status-bar preferences (`ui.statusBar`). */
export type StatusBarPrefs = z.infer<typeof StatusBarPrefsSchema>;

/**
 * Fully-defaulted {@link StatusBarPrefs} (nothing pinned — the line speaks only
 * when it has something to say). Parsed once so the config route, the client
 * selector, and the conf migration share one canonical default.
 */
export const STATUS_BAR_PREFS_DEFAULTS: StatusBarPrefs = StatusBarPrefsSchema.parse({});

/**
 * Person-scoped message-box preferences (`ui.composer`, DOR-948).
 *
 * Lives in server config rather than client `localStorage` so the choice follows
 * the person to every client on this machine, the same reasoning
 * {@link StatusBarPrefsSchema} gives for pins.
 */
export const ComposerPrefsSchema = z.object({
  /**
   * Whether the message box shows formatting as you type — bold, headings, and
   * lists take shape while you write, instead of staying as markdown characters.
   *
   * **Ships `true` for chat.** The repo owner made that call on 2026-08-12,
   * ahead of the graduation criteria in
   * `specs/composer-rich-text/02-specification.md` §Decision 5 — the IME and
   * screen-reader rungs of that ladder are still owed a person in a real
   * browser, and turning this on is how they get exercised. The Settings →
   * Advanced switch is the escape hatch: anyone whose box misbehaves puts it
   * back without hand-editing `~/.dork/config.json`.
   *
   * The switch (and this field with it) comes out when the plain textarea path
   * is removed, which is blocked on the nested-list serialize fix rather than on
   * anything here.
   */
  richText: z.boolean().default(true),
});

/** Person-scoped message-box preferences (`ui.composer`). */
export type ComposerPrefs = z.infer<typeof ComposerPrefsSchema>;

/**
 * Fully-defaulted {@link ComposerPrefs} (formatting as you type, on). Parsed
 * once so the config route, the client selector, and the conf migration share
 * one canonical default.
 */
export const COMPOSER_PREFS_DEFAULTS: ComposerPrefs = ComposerPrefsSchema.parse({});

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

/**
 * One remote MCP server the raw-MCP connector exposes as a connectable service
 * (`connectors.rawMcpServers`, connector-completion spec §Detailed Design 1).
 * Read at boot by the connector bootstrapper; config edits take effect on the
 * next server start.
 */
export const RawMcpServerConfigSchema = z.object({
  /** Stable service slug used as the toolkit id, e.g. `'notion'`. */
  slug: z.string().min(1),
  /** Human-facing name shown in the connect picker. */
  displayName: z.string().min(1),
  /** The remote MCP endpoint URL. */
  url: z.string().url(),
  /** Streamable HTTP or SSE — the two remote MCP transports. */
  transport: z.enum(['http', 'sse']),
});

/** One configured remote MCP server. See {@link RawMcpServerConfigSchema}. */
export type RawMcpServerConfig = z.infer<typeof RawMcpServerConfigSchema>;

/**
 * One Claude Code account DorkOS knows about — a Claude config directory holding
 * its own `projects/` transcripts and its own sign-in
 * (`runtimes.claudeCode.accounts`, spec `claude-code-accounts` D1).
 *
 * The **path is the identity**: it is literally what `CLAUDE_CONFIG_DIR` takes,
 * so there is no id to generate, migrate, or keep in step with anything. The
 * label exists because the operator's real question is _which client_ a session
 * belongs to, and `~/.claude2` does not answer that while "Acme Corp" does.
 */
export const ClaudeCodeAccountSchema = z.object({
  /** Absolute path of the Claude config directory this account lives in. */
  path: z.string().min(1),
  /** What the operator calls this account; `null` when they have not named it. */
  label: z.string().nullable(),
});

/** One known Claude Code account. See {@link ClaudeCodeAccountSchema}. */
export type ClaudeCodeAccount = z.infer<typeof ClaudeCodeAccountSchema>;

/**
 * The model a NEW session on one runtime starts on, or `null` to let that
 * runtime pick its own — which is exactly the behavior before this field existed.
 *
 * **Per runtime, and it has to be.** A model id is only meaningful inside the
 * runtime that offers it: `opus` means nothing to Codex, `gpt-5.3-codex` nothing
 * to Claude Code, and OpenCode addresses models as `provider/model`. One shared
 * `runtimes.defaultModel` would therefore be wrong for at least two of the three
 * the moment anybody set it, and the failure would be silent — a runtime asked
 * for a model it has never heard of. Three leaves cost three rows in the
 * exhaustiveness tables and buy an answer that is true for whichever runtime a
 * session lands on.
 *
 * Not validated against a live catalog here. The catalogs are per-runtime, remote,
 * and change under us; a schema that rejects tomorrow's model id is worse than a
 * value the runtime declines. An unrecognized id surfaces as the warning chip
 * (design §3.4), never as a refused write.
 */
const DefaultModelSchema = z.string().min(1).nullable().default(null);

/**
 * The reasoning effort a NEW session on one runtime starts at, or `null` to let
 * the runtime pick — again byte-for-byte today's behavior.
 *
 * The value space is the shared {@link EFFORT_LEVELS} ladder, never a per-runtime
 * fork. What differs per runtime is what a rung MEANS: claude-code and codex clamp
 * `none`/`minimal` differently, which the two clamp sites document precisely
 * because one shared default makes the divergence visible to a person.
 *
 * **OpenCode has no such leaf, on purpose.** Its prompt API takes no effort field
 * in either the pinned or the current SDK — effort exists there only as
 * config-file variants with no API selection. A schema field would imply a setting
 * that does nothing, so the honest shape is a section that simply does not have
 * one, and the UI says "Not supported by OpenCode" rather than hiding the row
 * (design §4, "unsupported means said").
 */
const DefaultEffortSchema = z.enum(EFFORT_LEVELS).nullable().default(null);

/**
 * How much a NEW session may do without asking, or `null` to let the runtime
 * decide — which is byte-for-byte the behavior before this field existed, and
 * the shipped default (spec `trust-dial`, decision 6).
 *
 * **A stop, never a mode id.** `'ask' | 'act' | 'autonomy'` are the three
 * positions of the Trust Dial, and they mean the same thing on every runtime;
 * the mode id that sits at a position does not (`bypassPermissions` on Claude
 * Code, `danger-full-access` on Codex). Storing the stop is what lets one
 * setting be true for a person who runs all three runtimes, and it is resolved
 * against whichever runtime a session actually lands on, through that runtime's
 * own capability profile. A runtime with no mode at the stored stop contributes
 * nothing and starts at its own default.
 *
 * Mirrors {@link PermissionStop} in `agent-runtime.ts`, which is the authority
 * on the vocabulary. Restated as a Zod enum rather than imported because this
 * module is deliberately dependency-light (it is bridged to JSON Schema and read
 * by the CLI); the two are pinned together by
 * `packages/shared/src/__tests__/config-schema.test.ts`.
 *
 * Writing `'autonomy'` into one of these leaves is consent-gated at the config
 * route — see `AUTONOMY_ACK_REQUIRED` — because it decides how every future
 * session starts, not just this one.
 */
const DefaultTrustStopSchema = z.enum(['ask', 'act', 'autonomy']).nullable().default(null);

const LoggingConfigSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  maxLogSizeKb: z.number().int().min(100).max(10240).default(500),
  maxLogFiles: z.number().int().min(1).max(30).default(14),
});

export const UserConfigSchema = z.object({
  version: z.literal(1),
  server: z
    .object({
      /**
       * **Something else depends on this exact number, not just on there being
       * a default.** `conf` materializes defaults to disk, so every
       * `config.json` in the world already carries this value whether or not
       * anyone chose it. `PREFERRED_SERVER_PORT` in
       * `apps/desktop/src/main/server-port.ts` compares against it to tell a
       * port a person pinned from the one the library wrote — a pinned port is
       * claimed strictly, an unchosen one steps past a conflict. Move this
       * without moving that and every install's written-out default reads as a
       * deliberate pin, so the desktop app refuses to start instead of stepping
       * past a busy port. `config-schema.test.ts` fails with that explanation
       * if the two drift.
       */
      port: z.number().int().min(1024).max(65535).default(4242),
      cwd: z.string().nullable().default(null),
      boundary: z.string().nullable().default(null),
      open: z.boolean().default(true),
    })
    .default(() => ({ port: 4242, cwd: null, boundary: null, open: true })),
  tunnel: z
    .object({
      enabled: z.boolean().default(false),
      domain: z.string().nullable().default(null),
      authtoken: z.string().nullable().default(null),
      auth: z.string().nullable().default(null),
    })
    .default(() => ({
      enabled: false,
      domain: null,
      authtoken: null,
      auth: null,
    })),
  ui: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).default('system'),
      dismissedUpgradeVersions: z
        .array(z.string())
        .default(() => [])
        .describe('Version strings the user has dismissed upgrade notifications for'),
      /** Server-persisted sidebar organization (groups, pinned, per-section sort/collapse). */
      sidebar: SidebarPrefsSchema.default(() => ({
        pinned: [],
        groups: [],
        sections: {},
        muted: [],
        gettingStarted: { retired: [] },
        digest: {},
      })),
      /** Person-scoped Shape state (active Shape, reverse affinity hints, follow toggle). */
      shapes: ShapeUserPrefsSchema.default(() => ({
        active: null,
        agentDefaults: {},
        autoFollowAgent: false,
      })),
      /** Person-scoped status-line pins (DOR-431, DOR-452). */
      statusBar: StatusBarPrefsSchema.default(() => ({ pins: [] })),
      /** Person-scoped message-box preferences (DOR-948). */
      composer: ComposerPrefsSchema.default(() => ({ richText: true })),
      /**
       * When this person last read what Full autonomy means and said "don't ask
       * me again", as an ISO 8601 UTC string. `null` until they do, which is the
       * shipped state (spec `trust-dial`, decision 5).
       *
       * A timestamp rather than a boolean because the record is only worth
       * keeping if it says WHEN: Settings shows the date back, and a person who
       * cannot remember agreeing to anything can see the moment they did and
       * clear it.
       *
       * ## This is a consent ritual, not a security boundary
       *
       * Read that sentence before building anything on this field. The server
       * refuses to put an interactive session into Full autonomy unless the
       * request carries an acknowledgement — either `acknowledgedAutonomy: true`
       * on the PATCH, or this standing record. That closes the gap where a
       * *client* could skip the dialog. It does NOT stop an API caller: anything
       * that can reach the route can send `acknowledgedAutonomy: true` itself,
       * and nothing here would know the difference. The boundary against agent
       * callers is a separate piece of work (`agent-approval-settings`, DOR-501)
       * and this field is not it. Do not describe it as one.
       *
       * Lives under `ui` rather than `approvals` on purpose. `approvals.*` is
       * security policy — every leaf there requires login to write, because those
       * settings decide what the approval gate enforces. This one decides what a
       * dialog does, and requiring login to dismiss a dialog would make the
       * feature unreachable on the default login-off install. It is still
       * `operator-only` to write, so an agent cannot forge a person's consent
       * record.
       */
      autonomyAcknowledgedAt: z.string().datetime().nullable().default(null),
    })
    .default(() => ({
      theme: 'system' as const,
      dismissedUpgradeVersions: [],
      sidebar: {
        pinned: [],
        groups: [],
        sections: {},
        muted: [],
        gettingStarted: { retired: [] },
        digest: {},
      },
      shapes: {
        active: null,
        agentDefaults: {},
        autoFollowAgent: false,
      },
      statusBar: { pins: [] },
      composer: { richText: true },
      autonomyAcknowledgedAt: null,
    })),
  logging: LoggingConfigSchema.default(() => ({
    level: 'info' as const,
    maxLogSizeKb: 500,
    maxLogFiles: 14,
  })),
  relay: z
    .object({
      enabled: z.boolean().default(true),
      dataDir: z.string().nullable().default(null),
    })
    .default(() => ({ enabled: true, dataDir: null })),
  /**
   * Letting agents on other systems talk to the agents on this one.
   *
   * A2A is a shared language for agents built by different people. Turn this on
   * and DorkOS publishes a card describing your agents and opens an address
   * outside apps can send work to; leave it off and nothing outside DorkOS can
   * reach them this way. Off is how it ships, and it needs Agent messaging on to
   * do anything at all.
   *
   * `DORKOS_A2A_ENABLED` in the environment overrules this setting in both
   * directions, the same way `DORKOS_RELAY_ENABLED` overrules
   * {@link UserConfigSchema} `relay.enabled` — a headless deployment keeps
   * deciding from its environment. Read once at boot, so a change waits for the
   * next start.
   */
  a2a: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default(() => ({ enabled: false })),
  scheduler: z
    .object({
      enabled: z.boolean().default(true),
      maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
      timezone: z.string().nullable().default(null),
      retentionCount: z.number().int().min(1).default(100),
    })
    .default(() => ({
      enabled: true,
      maxConcurrentRuns: 1,
      timezone: null,
      retentionCount: 100,
    })),
  mesh: z
    .object({
      scanRoots: z.array(z.string()).default(() => []),
    })
    .default(() => ({ scanRoots: [] })),
  rooms: z
    .object({
      /**
       * How many replies in a row agents may send each other before the room
       * stops them (ADR 260726-170127). Your own messages always start the
       * count over, so a room the limit has quietened is one message away from
       * running again. `0` turns automatic replies off entirely.
       */
      maxAgentDepth: z.number().int().min(0).max(10).default(3),
      /**
       * The most automatic replies any ONE room may run in an hour, counted
       * whoever asked for them.
       *
       * The reply limit above bounds one conversation and reads who is writing
       * to do it. With **Require login** off — the default — DorkOS cannot tell
       * a program on your machine from you, so that reading can be sidestepped.
       * This one cannot: it counts every automatic reply a room runs and stops
       * at the number, whoever the message appeared to come from.
       *
       * It bounds a ROOM, not your bill — rooms are free to create, so this
       * alone can be multiplied by making more of them. `maxAutomaticTurnsTotalPerHour`
       * is the one that bounds the total. This one keeps a single busy room from
       * eating that whole allowance.
       */
      maxAutomaticTurnsPerRoomPerHour: z.number().int().min(0).max(10_000).default(60),
      /**
       * The most automatic replies this DorkOS may run in an hour, across every
       * room that exists.
       *
       * This is the ceiling on what automatic replies can cost you. It does not
       * care how many rooms or threads exist, or who the messages appeared to
       * come from. `0` stops automatic replies entirely.
       */
      maxAutomaticTurnsTotalPerHour: z.number().int().min(0).max(100_000).default(240),
      /**
       * How long a room waits for an agent's answer before it carries on
       * without it.
       *
       * The agent is NOT stopped. It keeps working, and its answer is posted
       * when it lands, saying which message it answers and how late it is. This
       * only decides how long the room holds its breath.
       *
       * Like every number in this area, this one is a judgement rather than a
       * measurement — see `meta/agent-etiquette.md` §9. Tune it to how long your
       * agents actually take.
       */
      replyWaitMinutes: z.number().int().min(1).max(120).default(10),
      /**
       * When a room gives up on a turn altogether and says the agent could not
       * answer.
       *
       * Counted from the same moment as `replyWaitMinutes` and always longer
       * than it: the wait is when the room stops waiting, this is when it stops
       * listening. Reaching it means an agent that kept producing output and
       * never finished, which is a fault worth reporting rather than waiting on
       * forever. Also a judgement, not a measurement (`meta/agent-etiquette.md`
       * §9).
       */
      lateReplyCeilingMinutes: z.number().int().min(1).max(1440).default(60),
      /**
       * How long an agent stays addressable after you talk to it, before it goes
       * back to needing an @mention. Talking to it again starts the clock over.
       *
       * This is the ceiling, not the setting: a room can hold an agent to a
       * shorter window, never a longer one. `0` means an agent is only ever
       * addressable by @mention, whatever any room says.
       *
       * Like every number in this area, it is a judgement rather than a
       * measurement — see `meta/agent-etiquette.md` §9. Nobody publishes a
       * defensible figure for how long a person expects to keep talking to
       * something without naming it again, so this one is ours, to be tuned by
       * using the product.
       */
      engagedWindowMinutes: z.number().int().min(0).max(1440).default(10),
      /**
       * How many messages from other people can go by before an agent stops
       * treating itself as part of the conversation. Talking to it again starts
       * the count over.
       *
       * The second half of the same window, and it ends on whichever runs out
       * first — a quiet ten minutes and a busy ten messages are both reasons to
       * stop assuming a question was meant for you. Also a ceiling, and also a
       * judgement rather than a measurement.
       */
      engagedWindowPosts: z.number().int().min(0).max(100).default(5),
      /**
       * How long an agent waits for the room to stop talking before it answers,
       * in milliseconds.
       *
       * When several people say things at once, the messages are gathered up and
       * answered together — one considered reply instead of one rushed reply per
       * message. This is how long "at once" means. Nothing is dropped: a message
       * that arrives after the pause simply starts the next answer.
       *
       * Like every number in this area, it is a judgement rather than a
       * measurement — see `meta/agent-etiquette.md` §9.
       */
      collectDebounceMs: z.number().int().min(0).max(10_000).default(500),
      /**
       * The most messages one gathered-up answer covers.
       *
       * Reaching it answers straight away instead of waiting out the pause, so a
       * room that never goes quiet still gets replies. The messages past it are
       * not lost — they start the next answer.
       */
      collectMaxEntries: z.number().int().min(1).max(200).default(20),
    })
    .default(() => ({
      maxAgentDepth: 3,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    })),
  /**
   * What your agents may say when you come back after being away (spec
   * `team-room-home`, D5.2).
   *
   * The iron rule the numbers here enforce is **news, not noise**: coming back
   * to three useful lines is a welcome; coming back to twelve is a reason to
   * turn the feature off. Every leaf is a ceiling on the noise, never a target
   * to fill, so an install where nothing happened while you were gone stays
   * silent whatever these say.
   */
  welcomeBack: z
    .object({
      /**
       * Whether agents may post at all when you return. Off means no post, and
       * no work done to decide there was nothing to post.
       */
      enabled: z.boolean().default(true),
      /**
       * How long you have to be away before coming back counts as a return.
       *
       * Four hours by default — long enough that something real has happened
       * since, short enough to catch a morning. The floor is a quarter of an
       * hour because anything shorter is a coffee, not an absence, and would
       * turn the feature into the thing it exists to avoid. The ceiling is a
       * week, past which "what changed" is a question the feed answers better
       * than a greeting does.
       */
      absenceThresholdMinutes: z.number().int().min(15).max(10_080).default(240),
      /**
       * The most posts one return may produce, however many agents qualify.
       *
       * Three, because a welcome is read at a glance. When more agents have
       * news than this allows, the most useful ones post and the rest stay
       * quiet — the cap is never spent for its own sake. `0` silences the posts
       * while leaving the feature on; turning it off with `enabled` is the
       * cheaper way to get the same silence, since that also skips the work of
       * deciding who had news.
       */
      maxPosts: z.number().int().min(0).max(10).default(3),
      /**
       * Whether a greeting may also carry a next-step offer — and with it, the
       * one model turn per agent that finding out costs.
       *
       * **On by default, and still its own switch, which is the point.** A note
       * that ends in "want me to open the PR?" is the part of coming back that
       * is worth reading, so an install where nobody ever finds that switch is
       * an install that never sees the feature. Everything else in this block is
       * derived from session state and costs nothing; an offer is not — the only
       * honest way to learn whether an agent has a next step worth your decision
       * is to ask it, which runs it for a turn. So the spend is bounded to the
       * agents `maxPosts` already let speak (never every agent, never one with
       * no news), the switch itself states the cost in the sentence beside it,
       * and turning it off is one click that this feature never takes back:
       * nothing — no upgrade, no migration, no config wipe — flips it on again.
       */
      offersEnabled: z.boolean().default(true),
    })
    .default(() => ({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    })),
  onboarding: OnboardingStateSchema.default(() => ({
    completedSteps: [],
    skippedSteps: [],
    startedAt: null,
    dismissedAt: null,
    completedAt: null,
    runtimeDefaultSetAt: null,
  })),
  tours: ToursStateSchema.default(() => ({ seen: [], declined: [] })),
  /** Who the user is, in their own words. Local-only — see {@link UserProfileSchema}. */
  profile: UserProfileSchema.default(() => ({
    roles: [],
    tools: [],
    displayName: null,
    rolePromptDismissedAt: null,
  })),
  agentContext: z
    .object({
      relayTools: z.boolean().default(true),
      meshTools: z.boolean().default(true),
      adapterTools: z.boolean().default(true),
      tasksTools: z.boolean().default(true),
    })
    .default(() => ({ relayTools: true, meshTools: true, adapterTools: true, tasksTools: true })),
  uploads: z
    .object({
      maxFileSize: z
        .number()
        .int()
        .positive()
        .default(10 * 1024 * 1024), // 10MB
      maxFiles: z.number().int().min(1).max(50).default(10),
      allowedTypes: z.array(z.string()).default(() => ['*/*']),
    })
    .default(() => ({
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 10,
      allowedTypes: ['*/*'],
    })),
  agents: z
    .object({
      /** See {@link DEFAULT_AGENTS_DIRECTORY} — the default is not a literal path. */
      defaultDirectory: z.string().default(DEFAULT_AGENTS_DIRECTORY),
      defaultAgent: z.string().default('dorkbot'),
    })
    .default(() => ({ defaultDirectory: DEFAULT_AGENTS_DIRECTORY, defaultAgent: 'dorkbot' })),
  extensions: z
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
    })
    .default(() => ({ enabled: [], disabled: [], approvedToRun: [] })),
  mcp: z
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
    })),
  /**
   * Shared consent namespace for everything DorkOS can send to dorkos.ai, split
   * into two tiers (ADR 260713-143958):
   *
   * - **Tier 1 — anonymous, opt-IN:** `install`, `heartbeat` and `usage` default
   *   to `false`. They are genuinely anonymous aggregate signals (no IP, no
   *   fingerprint, no content, no paths — only a random per-machine id), which
   *   is what once justified collecting them by default. They no longer are:
   *   ADR 260727-181825 holds that a default lands on the option protecting the
   *   person, and "anonymous" is a property of the payload, not a substitute for
   *   an answer. The notice-before-first-send rule (`hasTier1SendGate`) still
   *   applies on top, so nothing sends before the notice either way.
   * - **Tier 2 — identified/third-party, opt-in:** `errorReporting` defaults to
   *   `false` and never turns on without an explicit choice.
   *
   * `userHasDecided` is the one shared gate: it records that the user has
   * answered a consent prompt (kept sharing or turned off) so no channel
   * re-prompts. The namespace is deliberately per-channel so future work hangs
   * off the same object without a schema redesign. See the /telemetry page.
   */
  telemetry: z
    .object({
      /**
       * Shared consent gate. `true` once the user has answered a telemetry
       * consent prompt either way (kept sharing or turned off), which stops the
       * first-run consent banner from reappearing for any channel.
       */
      userHasDecided: z.boolean().default(false),
      /**
       * Tier 1 channel (anonymous, opt-in): send anonymous marketplace install
       * events to dorkos.ai so we can rank packages and spot install failures.
       * Defaults `false` — sharing starts when a person says so (ADR
       * 260727-181825). The notice-before-first-send gate (`hasTier1SendGate`)
       * still applies. Formerly `telemetry.enabled`. Privacy contract:
       * https://dorkos.ai/marketplace/privacy
       */
      install: z.boolean().default(false),
      /**
       * Tier 1 channel (anonymous, opt-in): send a daily anonymous heartbeat to
       * dorkos.ai (instance id, version, OS/arch, configured runtimes, tunnel +
       * cloud-link flags, and rough counts — never prompts, code, paths, or
       * session content). Defaults `false` — sharing starts when a person says
       * so (ADR 260727-181825). The notice-before-first-send gate
       * (`hasTier1SendGate`) still applies. Payload documented verbatim at
       * https://dorkos.ai/telemetry.
       */
      heartbeat: z.boolean().default(false),
      /**
       * Tier 2 channel (opt-in): send scrubbed crash reports to DorkOS's own
       * ingest at dorkos.ai (which forwards to PostHog Error Tracking), never to
       * a third party. Defaults `false` and turns on only by an explicit opt-in
       * (never the first-run banner); the notice-before-send gate does not apply.
       * The raw message is never sent and paths/tokens are scrubbed. See ADR
       * 260711-153307 (scrubbing) + 260713-143958 Phase 6 (destination).
       */
      errorReporting: z.boolean().default(false),
      /**
       * The DorkOS version whose consent notice this install last saw, or `null`
       * if the user has never been prompted. Anchors the "re-prompt on a data
       * policy change" idiom (mirroring `dismissedUpgradeVersions`): a
       * never-answered install is only enrolled in the Tier 1 opt-out channels
       * after the first-run notice for that version has been shown. Read by
       * `hasTier1SendGate` to enforce notice-before-first-send. See ADR
       * 260713-143958.
       */
      lastPromptedVersion: z.string().nullable().default(null),
      /**
       * Channel: send curated, anonymous feature-usage events to dorkos.ai
       * (e.g. `app_started`, `session_created`) so we can see adoption funnels
       * and which runtimes get used. Curated named events only — never
       * autocaptured, never prompts, code, paths, or session content; the exact
       * catalog lives in `@dorkos/shared/telemetry-events`.
       *
       * Tier 1 posture: defaults to `false` — sharing starts when a person says
       * so (ADR 260727-181825, superseding 260713-143958 Phase 3). Like
       * `heartbeat`/`install` it also never sends until the first-run notice
       * gate is satisfied. Payload documented verbatim at
       * https://dorkos.ai/telemetry.
       */
      usage: z.boolean().default(false),
      /**
       * Tier 2 channel (opt-in): when linking this install to a DorkOS account,
       * also include the anonymous per-install telemetry `instanceId` in the
       * device-link descriptor, so the cloud can merge this install's anonymous
       * usage history onto the signed-in account person (DOR-320, ADR
       * 260713-143958 Phase 4). Defaults `false` and turns on only by an explicit
       * choice in the account-link flow (never the first-run banner); the env
       * kill switches (`DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED`) suppress it
       * too. The app treats this flag as the sole opt-in signal: the id is
       * threaded into the link descriptor ONLY when this is `true`, and its
       * presence there is what the site reads to alias the anonymous history (see
       * the app-side `cloud-link-client.ts` and the site's
       * `aliasInstanceToAccount`). The alias fires at link time, so opting in
       * after already linking only takes effect on a future re-link.
       */
      linkAnalyticsToAccount: z.boolean().default(false),
      /**
       * Tier 2 channel (opt-in): bridge anonymous AI-run METADATA to DorkOS's
       * own ingest at dorkos.ai (which forwards to PostHog's LLM analytics) — one
       * `$ai_generation` event per completed agent turn carrying only the model,
       * the runtime, token counts, timing, and cost. Never prompts, code, file
       * paths, or conversation content. Defaults `false` and turns on only by an
       * explicit opt-in (never the first-run banner); the notice-before-send gate
       * does not apply. Independent of `usage`. See ADR 260713-143958 Phase 7 and
       * https://dorkos.ai/telemetry.
       */
      aiMetadata: z.boolean().default(false),
    })
    .default(() => ({
      userHasDecided: false,
      install: false,
      heartbeat: false,
      errorReporting: false,
      lastPromptedVersion: null,
      usage: false,
      linkAnalyticsToAccount: false,
      aiMetadata: false,
    })),
  workspace: z
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
    })),
  harness: z
    .object({
      /**
       * Whether installing or uninstalling a marketplace plugin automatically
       * runs Harness Sync projection (re-projecting `.agents/` + installed
       * plugins to every harness). Defaults to `true`; set `false` to manage
       * projection manually via `dorkos harness sync`.
       */
      autoSync: z.boolean().default(true),
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
    })
    .default(() => ({ autoSync: true, approvedHooks: [] })),
  workbench: z
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
    .default(() => ({ defaultViewers: {}, terminalGraceTtlMinutes: 10, autoOpenDiff: true })),
  runtimes: z
    .object({
      /** Runtime id the registry selects as its default at boot. */
      default: z.string().default('claude-code'),
      /**
       * How much a new session may do without asking, on every runtime that has
       * no answer of its own. See {@link DefaultTrustStopSchema}; a
       * `runtimes.<runtime>.defaultTrustStop` beats this one.
       */
      defaultTrustStop: DefaultTrustStopSchema,
      claudeCode: z
        .object({
          /**
           * Absolute path of the Claude config directory a NEW session runs and
           * bills on. `null` inherits whatever the process already has —
           * `$CLAUDE_CONFIG_DIR`, else `~/.claude` — which is byte-for-byte the
           * behavior before this field existed.
           *
           * An explicit path OVERRIDES an inherited `CLAUDE_CONFIG_DIR`, so which
           * account runs the work stops depending on which terminal happened to
           * launch DorkOS. Stored as a path, never an index into
           * {@link ClaudeCodeAccountSchema} entries, so removing an account can
           * never silently repoint the selection at a different client
           * (spec `claude-code-accounts` D1/D2).
           */
          activeAccount: z.string().nullable().default(null),
          /**
           * The Claude accounts DorkOS knows about — what lets it show which
           * client a session belongs to. The operator registers these: DorkOS
           * never globs `~/.claude*`, because that guess sweeps up directories
           * that are not accounts at all (D4).
           */
          accounts: z.array(ClaudeCodeAccountSchema).default(() => []),
          /** Model a new claude-code session starts on. See {@link DefaultModelSchema}. */
          defaultModel: DefaultModelSchema,
          /** Effort a new claude-code session starts at. See {@link DefaultEffortSchema}. */
          defaultEffort: DefaultEffortSchema,
          /**
           * Trust stop a new claude-code session starts at, overriding
           * `runtimes.defaultTrustStop`. See {@link DefaultTrustStopSchema}.
           */
          defaultTrustStop: DefaultTrustStopSchema,
          /**
           * Whether a Claude Code chat keeps its agent running between your
           * messages instead of starting it up again for each one. Ships
           * `false`, which is how DorkOS has always worked: every message gets
           * its own run.
           *
           * Read when a chat's agent starts, so a chat already under way keeps
           * the way it started until its process is replaced. That is what lets
           * one machine run chats both ways at the same time and compare them on
           * the same work (spec `persistent-session-runtime` §P3).
           */
          persistentSession: z.boolean().default(false),
        })
        .default(() => ({
          activeAccount: null,
          accounts: [],
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
          persistentSession: false,
        })),
      opencode: z
        .object({
          enabled: z.boolean().default(true),
          /** Absolute path to the `opencode` binary; `null` resolves from PATH. */
          binaryPath: z.string().nullable().default(null),
          /** Sidecar server port; `0` picks an ephemeral port. */
          port: z.number().int().min(0).max(65535).default(0),
          /**
           * Selected provider id keying into the top-level {@link UserConfig.providers}
           * registry (e.g. `openrouter`, `openai`, `ollama`). `null` = no provider
           * chosen; the sidecar falls back to OpenCode's own host auth (ADR-0315).
           */
          provider: z.string().nullable().default(null),
          /**
           * Optional OpenAI-compatible base URL for a Direct provider (injected as
           * `OPENAI_BASE_URL` into the sidecar env). `null` = the provider default.
           */
          baseURL: z.string().nullable().default(null),
          /**
           * Model a new OpenCode session starts on, as `provider/model`. See
           * {@link DefaultModelSchema}. There is deliberately no `defaultEffort`
           * sibling — OpenCode's API takes no effort at all.
           */
          defaultModel: DefaultModelSchema,
          /**
           * Trust stop a new OpenCode session starts at, overriding
           * `runtimes.defaultTrustStop`. See {@link DefaultTrustStopSchema}.
           */
          defaultTrustStop: DefaultTrustStopSchema,
        })
        .default(() => ({
          enabled: true,
          binaryPath: null,
          port: 0,
          provider: null,
          baseURL: null,
          defaultModel: null,
          defaultTrustStop: null,
        })),
      codex: z
        .object({
          enabled: z.boolean().default(true),
          /** Absolute path to the `codex` binary; `null` resolves from PATH. */
          binaryPath: z.string().nullable().default(null),
          /**
           * Credential reference for Codex's API key (`keychain:`/`env:`/`file:`),
           * never a raw secret. `null` = delegate to `codex login` (ADR-0315). Codex
           * never receives its key via a subprocess env var — it never sets
           * `CodexOptions.env` — so this reference feeds the delegated-login path.
           */
          credentialRef: CredentialReferenceSchema.nullable().default(null),
          /** Model a new codex session starts on. See {@link DefaultModelSchema}. */
          defaultModel: DefaultModelSchema,
          /** Effort a new codex session starts at. See {@link DefaultEffortSchema}. */
          defaultEffort: DefaultEffortSchema,
          /**
           * Trust stop a new codex session starts at, overriding
           * `runtimes.defaultTrustStop`. See {@link DefaultTrustStopSchema}.
           */
          defaultTrustStop: DefaultTrustStopSchema,
        })
        .default(() => ({
          enabled: true,
          binaryPath: null,
          credentialRef: null,
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
        })),
    })
    .default(() => ({
      default: 'claude-code',
      defaultTrustStop: null,
      claudeCode: {
        activeAccount: null,
        accounts: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
        persistentSession: false,
      },
      opencode: {
        enabled: true,
        binaryPath: null,
        port: 0,
        provider: null,
        baseURL: null,
        defaultModel: null,
        defaultTrustStop: null,
      },
      codex: {
        enabled: true,
        binaryPath: null,
        credentialRef: null,
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
      },
    })),
  auth: z
    .object({
      /**
       * Whether local login (Better Auth) is required to use this instance.
       * Defaults to `false`: no auth gate runs and DorkOS shows no user concept
       * anywhere (progressive disclosure). The enable-login flow creates the
       * owner account and then flips this to `true`. See the accounts-and-auth
       * spec.
       */
      enabled: z.boolean().default(false),
    })
    .default(() => ({ enabled: false })),
  /**
   * Standing permissions: whether an operator may say "stop asking about this
   * agent doing this thing", and for how long one of those answers lasts
   * (spec `agent-approval-settings` §3.1).
   *
   * The policy lives here; the permissions themselves do not. A granted
   * permission has a creation time, an expiry, and a revocation, which is
   * operational state and belongs in SQLite (`approval_grants`), not in a file a
   * person edits. Keeping them out also means nothing about WHICH agents are
   * trusted can ever leave through `config_get`.
   *
   * Both leaves are `operator-only`, writing either requires a session cookie
   * like every other operator-only setting, and on top of that neither can be
   * written at all while login is off — see `REQUIRES_LOGIN_CONFIG_PATHS`.
   */
  approvals: z
    .object({
      /**
       * Whether standing permissions may exist at all. Off by default: a safety
       * feature does not get quietly relaxed by an upgrade, so nothing changes
       * for an existing user until they ask for it.
       */
      standingGrants: z.boolean().default(false),
      /**
       * How long a new standing permission lasts, in minutes, counted from the
       * moment it is granted and never extended by use.
       *
       * Bounded in the schema, in both directions and on purpose. The maximum of
       * 1440 (one day) is what makes "forever" unrepresentable. The minimum of 5
       * keeps the window from becoming a deny-all that looks like a broken
       * feature, which is the reasoning already applied to the approval window in
       * `approval-service.ts`.
       */
      trustWindowMinutes: z
        .number()
        .int()
        .min(MIN_TRUST_WINDOW_MINUTES)
        .max(MAX_TRUST_WINDOW_MINUTES)
        .default(DEFAULT_TRUST_WINDOW_MINUTES),
      /**
       * The moment the settings last stopped licensing standing permissions, as
       * an ISO 8601 UTC string. Every permission granted at or before it is void
       * and is never honored again (DOR-520). `null` until the posture has
       * narrowed once.
       *
       * Machine-managed, like `onboarding` and `tours`: `ConfigManager` stamps it
       * on any write that takes `auth.enabled` or `standingGrants` away, and
       * nothing else should write it by hand.
       *
       * It lives in the config file rather than beside the permissions in SQLite
       * for one reason, and it is the whole point of the field: `dorkos config
       * set` runs in a process with no database, so the config file is the ONLY
       * thing every writer of these settings touches. A marker anywhere else
       * would be invisible to exactly the write that motivated it.
       *
       * Constrained to a real timestamp, not merely a string. The store treats a
       * FALSY floor as "no floor", so a bare `z.string()` let the empty string
       * through as a value that silently disables the filter — the one direction
       * this field must never fail. Garbage that is not empty already fails
       * closed (it sorts above every real timestamp, so everything is voided);
       * `''` was the single value that failed open.
       */
      standingGrantsVoidBefore: z.string().datetime().nullable().default(null),
    })
    .default(() => ({
      standingGrants: false,
      trustWindowMinutes: DEFAULT_TRUST_WINDOW_MINUTES,
      standingGrantsVoidBefore: null,
    })),
  cloud: z
    .object({
      /**
       * The scoped instance API key issued by the DorkOS cloud when this
       * instance is device-linked to an account (accounts-and-auth P2). Held as
       * the credential for `POST /api/instances/heartbeat`; a `401` from the
       * cloud means it was revoked (unlinked). Sensitive — see
       * {@link SENSITIVE_CONFIG_KEYS}. `null` when this instance is not linked.
       */
      instanceToken: z.string().nullable().default(null),
      /** This instance's display name registered with the cloud (typically the hostname). */
      instanceName: z.string().nullable().default(null),
      /** Human-readable label of the linked DorkOS account, when the cloud reports one. */
      linkedAccountLabel: z.string().nullable().default(null),
    })
    .default(() => ({ instanceToken: null, instanceName: null, linkedAccountLabel: null })),
  /**
   * Connector gateway settings (connector-completion spec). `rawMcpServers`
   * lists the remote MCP servers the raw-MCP connector offers as connectable
   * services; the provider registers at boot with whatever is here — including
   * the empty list, so the seam is live before anyone configures a server.
   */
  connectors: z
    .object({
      /** Remote MCP servers the raw-MCP connector exposes (boot-read). */
      rawMcpServers: z.array(RawMcpServerConfigSchema).default(() => []),
    })
    .default(() => ({ rawMcpServers: [] })),
  /**
   * Per-provider credential references, keyed by a stable provider id
   * (`anthropic`, `openrouter`, `openai`, …). Values are references
   * (`keychain:`/`env:`/`file:`), NEVER raw secrets — the connect endpoints
   * write a reference here and the `CredentialProvider` port resolves it at the
   * runtime env-injection seam (ADR-0315).
   */
  providers: z.record(z.string(), CredentialReferenceSchema).default(() => ({})),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

/** Maps log level names to numeric values for consola compatibility */
export const LOG_LEVEL_MAP: Record<string, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/** Defaults extracted from schema for conf constructor */
export const USER_CONFIG_DEFAULTS: UserConfig = UserConfigSchema.parse({
  version: 1,
});
