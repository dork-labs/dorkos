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
/*
 * Most of the schema lives in `config-schema/`, one module per area; this file
 * composes `UserConfigSchema` and re-exports every public name, so the
 * `@dorkos/shared/config-schema` subpath is unchanged.
 *
 * What stays here, and why: the migration append-only guard
 * (`apps/server/src/services/core/__tests__/migration-closure.ts`) reads THIS
 * file as text and pins every declaration a shipped config migration reaches.
 * `ONBOARDING_STEPS`, `toSidebarItemRef`, the composer and notification prefs,
 * `slugifyAccountId`, `claudeAccountId` and `USER_CONFIG_DEFAULTS` are reached,
 * so moving one out of this file would silently drop it from the guard.
 * `config-schema/claude-accounts.ts` imports `claudeAccountId` back from here,
 * so the modules form a cycle. It is safe only while THIS file is evaluated
 * first. Importing `config-schema/claude-accounts.js` or
 * `config-schema/runtime-settings.js` first throws a TDZ `ReferenceError` at
 * load: the cycle runs this file's body while those two modules' `const`s are
 * still uninitialized. So nothing outside this file and its section modules
 * may import `config-schema/*`; import `@dorkos/shared/config-schema` (or
 * `./config-schema.js`) instead. `packages/shared/eslint.config.js` enforces it.
 */
import { z } from 'zod';
import { IMPLICIT_ACCOUNT_ID } from './account-identity.js';
// Built from plain id lists, never the named schemas in
// `permissions/permission-schemas.ts`: the same SRC-alias reason as `HARNESS_IDS`
// in `config-schema/tooling.ts`.
import { PermissionsSettingsSchema } from './config-permissions.js';
import { RelaySettingsSchema } from './config-relay.js';
import {
  AuthConfigSchema,
  CloudConfigSchema,
  ConnectorsConfigSchema,
} from './config-schema/auth-cloud.js';
import { CommunityNavigationPrefsSchema } from './config-schema/community-navigation.js';
import { UserProfileSchema } from './config-schema/profile.js';
import { RoomsConfigSchema } from './config-schema/rooms.js';
import { RuntimesConfigSchema } from './config-schema/runtime-settings.js';
import { SidebarPrefsSchema } from './config-schema/sidebar.js';
import type { SidebarItemRef } from './config-schema/sidebar.js';
import {
  DEFAULT_AGENTS_DIRECTORY,
  ExtensionsConfigSchema,
  HarnessConfigSchema,
  McpConfigSchema,
  WorkbenchConfigSchema,
  WorkspaceConfigSchema,
} from './config-schema/tooling.js';
import { ShapeUserPrefsSchema, StatusBarPrefsSchema } from './config-schema/ui-prefs.js';
import {
  ActivityConfigSchema,
  HeartbeatsConfigSchema,
  KeepAwakeConfigSchema,
  ServerConfigSchema,
} from './config-sections.js';
import { CredentialReferenceSchema } from './credential-reference.js';
import { BUILTIN_MEMORY_PROVIDER_ID } from './memory-provider.js';
import { SavedPlacementSchema } from './mini-app-placement.js';
import { SpacesSettingsSchema } from './spaces-settings.js';
import { ToursStateSchema } from './tours-state.js';
export {
  CommunityInstallationPathSchema,
  CommunityInstallationDestinationSchema,
  CommunityNavigationDestinationSchema,
  CommunityNavigationOwnerPrefsSchema,
  CommunityNavigationPrefsSchema,
} from './config-schema/community-navigation.js';
export type {
  CommunityNavigationDestination,
  CommunityInstallationPath,
  CommunityInstallationDestination,
  CommunityNavigationOwnerPrefs,
  CommunityNavigationPrefs,
} from './config-schema/community-navigation.js';
export {
  ROOM_TURN_LIMIT_BOUNDS,
  MAX_TOTAL_TURNS_PER_HOUR_BOUNDS,
  ROOM_TURN_LIMIT_DEFAULTS,
  MAX_CONCURRENT_TURNS_PER_AGENT_BOUNDS,
  MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT,
} from './config-schema/rooms.js';
export {
  DisplayNameSourceSchema,
  isValidTimeZone,
  WorkingHoursSchema,
  AwaySchema,
  UserProfileSchema,
  USER_PROFILE_DEFAULTS,
} from './config-schema/profile.js';
export type {
  DisplayNameSource,
  WorkingHours,
  Away,
  UserProfile,
} from './config-schema/profile.js';
export {
  SidebarDisplayFilterSchema,
  SidebarItemRefSchema,
  sameSidebarItem,
  SmartGroupRulesSchema,
  SidebarGroupSchema,
  SidebarSectionIdSchema,
  SidebarSectionPrefsSchema,
  SidebarPrefsSchema,
  SIDEBAR_PREFS_DEFAULTS,
} from './config-schema/sidebar.js';
export type {
  SidebarDisplayFilter,
  SidebarItemRef,
  SmartGroupRules,
  SidebarGroup,
  SidebarSectionId,
  SidebarSectionPrefs,
  SidebarPrefs,
} from './config-schema/sidebar.js';
export {
  ShapeUserPrefsSchema,
  SHAPE_USER_PREFS_DEFAULTS,
  StatusBarPinSchema,
  STATUS_BAR_PIN_KEYS,
  StatusBarPrefsSchema,
  STATUS_BAR_PREFS_DEFAULTS,
} from './config-schema/ui-prefs.js';
export type { ShapeUserPrefs, StatusBarPin, StatusBarPrefs } from './config-schema/ui-prefs.js';
export { DEFAULT_AGENTS_DIRECTORY } from './config-schema/tooling.js';
export {
  ProjectAccountsRuleSchema,
  ClaudeCodeAccountSchema,
  healClaudeAccountRename,
  settleLegacyAccountAlias,
  classifyClaudeAccountRows,
  readProjectRootList,
  readClaudeAccountSettings,
  configuredRuntimes,
  ClaudeCodeAccountsSchema,
  ClaudeAccountsSeenSchema,
  CLAUDE_ACCOUNTS_SEEN_KEY,
} from './config-schema/claude-accounts.js';
export type {
  ProjectAccountsRule,
  ClaudeCodeAccount,
  ClaudeAccountReadWarningCode,
  ClaudeAccountReadWarning,
  ClaudeAccountRowView,
  ReadClaudeAccount,
} from './config-schema/claude-accounts.js';
export {
  CODEX_TRANSPORTS,
  DefaultAccountColorSchema,
  ClaudeCodeSettingsSchema,
  DoeInferenceConfigSchema,
  DoeRuntimeSettingsSchema,
} from './config-schema/runtime-settings.js';
export type {
  CodexTransportSetting,
  DoeInferenceConfig,
} from './config-schema/runtime-settings.js';
export {
  RawMcpServerConfigSchema,
  CloudCreditsDefaultSchema,
  CloudCreditsSettingsSchema,
} from './config-schema/auth-cloud.js';
export type {
  RawMcpServerConfig,
  CloudCreditsDefault,
  CloudCreditsSettings,
} from './config-schema/auth-cloud.js';
export * from './credential-reference.js';
export * from './remote-access-settings.js';
export * from './extension-config-schemas.js';
export * from './tours-state.js';
export {
  RuntimeInheritedEnvNamesSchema,
  isReservedRuntimeEnvName,
  RUNTIME_RESERVED_ENV_NAMES,
} from './runtime-environment-schema.js';

export { RELAY_TURN_CEILING_BOUNDS, RELAY_TURN_CEILING_DEFAULTS } from './config-relay.js';

/** Sensitive fields that trigger a warning when set via CLI or API */
export const SENSITIVE_CONFIG_KEYS = [
  'tunnel.authtoken',
  'tunnel.auth',
  'mcp.apiKey',
  'cloud.instanceToken',
  'cloud.previousLinkProof',
] as const;

/**
 * The guided onboarding steps a first-time user walks through, in flow order:
 * choosing how much power their agents run with (`'power'`, spec
 * `full-power-defaults`), meeting DorkBot (personality), telling it what kind of
 * work you do (`'profile'`, the role beat from spec `user-profile-onboarding`),
 * and importing projects (`'discovery'`). The former `'tasks'` and `'adapters'`
 * values were retired (task scheduling moved out of onboarding; the adapters step
 * never shipped) — a config migration scrubs them from any persisted
 * `completedSteps`/`skippedSteps` so a narrowed enum never fails to parse an
 * upgraded config. Adding `'profile'` and `'power'` is the opposite move:
 * widening is additive, old stored arrays still parse, and no scrub migration is
 * needed. `scrubRetiredOnboardingSteps` filters to whatever this set holds, so a
 * wider set only ever keeps MORE — it cannot make a shipped migration delete
 * something new.
 *
 * **A step is flow progress, never consent.** `'power'` records that the person
 * reached and left the power stage; whether they saw what agents may do is
 * {@link UserConfig.ui}`.trustNoticeSeenAt`, which the stage itself writes. A
 * skipped stage records no answer.
 */
export const ONBOARDING_STEPS = ['power', 'meet-dorkbot', 'profile', 'discovery'] as const;

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
  /**
   * Which first-run path the person picked on the Welcome screen (spec
   * `one-minute-onboarding` §4.1): DorkOS's own account, their own AI, or no
   * account yet. `null` until they pick. `'dorkos'` is what lets a NEW link
   * record credits as the person's choice for the DorkOS runtime, and only
   * while `completedAt` is still null.
   */
  firstRunPath: z.enum(['dorkos', 'own', 'none']).nullable().default(null),
  /**
   * The #team entry DorkBot's first-run welcome was posted as, so posting it is
   * done once and the suggestion chips know which entry they sit under.
   */
  welcomeEntryId: z.string().nullable().default(null),
  /**
   * The default runtime as it was before the first-run route's first call, so
   * choosing another path can put `runtimes.default` and DorkBot back first.
   */
  priorRuntime: z.string().nullable().default(null),
});

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
/**
 * Convert one STORED membership entry into a {@link SidebarItemRef}.
 *
 * A `ui.sidebar` written before DOR-579 holds bare agent `projectPath` strings
 * in `pinned`, `muted` and each group's member list. Rooms did not exist in the
 * sidebar then, so every such string IS an agent path and the mapping is total —
 * there is no value that could be misread.
 *
 * This is the single statement of that rule, and the config migration that
 * rewrites the file is now its only caller: the read-time conversion beside it
 * was removed one release on (DOR-588).
 *
 * @param entry - A stored entry: either a reference already, or a legacy path.
 * @returns The entry as a reference; an existing reference passes through.
 */
export function toSidebarItemRef(entry: SidebarItemRef | string): SidebarItemRef {
  return typeof entry === 'string' ? { kind: 'agent', path: entry } : entry;
}
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
 * How long something may sit waiting on you before DorkOS tries your phone.
 *
 * Minutes, or `'never'` for "the cockpit and this computer are the only places
 * I want to hear about it". Four steps rather than a free number because the
 * question a person is actually answering is coarse — "right away", "give me a
 * moment", "only if I have really walked off" — and a spinner asking for 7
 * invites a precision the ladder does not have.
 */
export const EscalationDelaySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(5),
  z.literal(15),
  z.literal('never'),
]);

/** How long something may wait before DorkOS tries your phone. */
export type EscalationDelay = z.infer<typeof EscalationDelaySchema>;

/**
 * How DorkOS gets your attention (`notifications`, spec `notification-system`).
 *
 * Person-scoped and server-held rather than per-browser, for the reason
 * {@link ComposerPrefsSchema} gives above: "how loud may my agents be" is a fact
 * about the person, and answering it on a laptop should answer it on a phone.
 */
export const NotificationPrefsSchema = z.object({
  escalation: z
    .object({
      /**
       * How long a blocked agent waits for you here before DorkOS tries a
       * louder channel. `'never'` keeps everything on this computer.
       *
       * Two minutes by default: long enough that stepping away from the keyboard
       * for a moment does not buzz a phone, short enough that a ten-minute
       * prompt window is not mostly gone before anybody is told.
       */
      phoneAfterMinutes: EscalationDelaySchema.default(2),
    })
    .default(() => ({ phoneAfterMinutes: 2 as const })),
  sounds: z
    .object({
      /** A soft knock when an agent stops and needs you. */
      knock: z.boolean().default(true),
      /** A gentle chord when the last thing waiting on you is answered. */
      allClear: z.boolean().default(true),
      /**
       * A chime every time any turn finishes.
       *
       * **Off**, and the change is deliberate: it used to be on for every turn
       * of every session, which on a fleet of agents is a sound with no
       * information in it. The knock above is the one that means something.
       */
      turnEnd: z.boolean().default(false),
    })
    .default(() => ({ knock: true, allClear: true, turnEnd: false })),
  /**
   * Whether news that is worth knowing but is not blocking anything — a turn
   * that finished, a message addressed to you — may raise a notification while
   * you are looking at something else.
   *
   * One switch for the whole class rather than a grid of per-kind toggles. It is
   * named for the case that dominates it (a turn finishing while you are away),
   * and a per-kind matrix is the thing this deliberately is not: research §5.4
   * has the argument, and the short version is that nobody tends a matrix.
   *
   * Only ever consulted while the window is hidden. Nothing pops up over what
   * you are already reading.
   */
  notifyOnTurnCompleteWhileAway: z.boolean().default(true),
  /**
   * Whether this person has already answered the browser-permission card.
   *
   * Set by pressing either button on it — "Not now" as much as "Turn on
   * notifications", because the card's promise is that it is asked once. It is
   * config rather than browser storage so that "not now" said on a laptop is not
   * re-asked on a phone.
   */
  browserPermissionPrimerDismissed: z.boolean().default(false),
});

/** How DorkOS gets your attention (`notifications`). */
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/**
 * Fully-defaulted {@link NotificationPrefs}. Parsed once so the config route,
 * the cockpit's own reader, and the conf migration share one canonical default.
 */
export const NOTIFICATION_PREFS_DEFAULTS: NotificationPrefs = NotificationPrefsSchema.parse({});
/**
 * Reduce a name to the kebab-case alphabet account ids use.
 *
 * Lowercased, every run of non-alphanumerics collapsed to a single hyphen, and
 * the ends trimmed. Returns `''` when nothing survives — the caller decides what
 * to fall back to, because "the label slugified to nothing" and "there was no
 * label" want the same answer and only the caller knows the next candidate.
 *
 * @param value - Free-form text (a label, a path basename).
 * @returns The kebab slug, possibly empty.
 */
export function slugifyAccountId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      // `^-|-$`, not `^-+|-+$`: the collapse above leaves hyphen runs of length
      // one, so the `+` can never do anything except retry at every offset of a
      // run that cannot exist (quadratic, CodeQL js/polynomial-redos).
      .replace(/^-|-$/g, '')
  );
}

/**
 * The id to register a Claude account under: the label slugified, else the
 * path's last segment slugified, else `account` — uniquified against ids already
 * taken by appending `-2`, `-3`, … .
 *
 * One implementation for the config migration that backfills ids onto existing
 * registries and for the settings UI that registers a new account, so an id
 * minted by either is minted by the same rule.
 *
 * `default` is always taken (contract §1.1a): it names the runtime's default
 * account, so a label "Default" or a folder called `default` mints
 * `default-2`. The `'0.65.0'` migration reaches this function, so that rule
 * applies to an install minting its ids for the first time; `'0.87.0'` renames
 * a row an earlier build already minted as `default`.
 *
 * @param opts - The account being named and the ids already in use.
 * @param opts.label - The operator's name for the account, if they gave one.
 * @param opts.path - The account's config directory (its basename is the fallback).
 * @param opts.taken - Ids already present in the registry.
 * @returns A kebab slug that is not in `taken`.
 */
export function claudeAccountId(opts: {
  label?: string | null;
  path: string;
  taken: Iterable<string>;
}): string {
  const basename =
    opts.path
      // The lookbehind pins the attempt to the START of the trailing separator
      // run, which is where the leftmost match already began — same result,
      // without retrying at every offset of the run (CodeQL js/polynomial-redos).
      .replace(/(?<![/\\])[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  const base = slugifyAccountId(opts.label ?? '') || slugifyAccountId(basename) || 'account';
  const taken = new Set(opts.taken);
  taken.add(IMPLICIT_ACCOUNT_ID);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const LoggingConfigSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  maxLogSizeKb: z.number().int().min(100).max(10240).default(500),
  // Days of rotated logs kept, within 200 MB in all. It counted files until the
  // log began rotating while the server runs, many files a day (DOR-2902).
  maxLogFiles: z.number().int().min(1).max(30).default(14),
});
export const UserConfigSchema = z.object({
  version: z.literal(1),
  server: ServerConfigSchema,
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
      /**
       * Which feature promos this person has waved away, by promo id.
       *
       * Lives beside {@link UserConfigSchema} `ui.dismissedUpgradeVersions` and
       * for the same reason: "I have seen this and I do not want it again" is a
       * fact about the person, not about the browser they happened to be in.
       * The list used to live in `localStorage`, so dismissing a card on a
       * laptop left it waiting on a phone (spec `sidebar-simplification` D4).
       *
       * Unknown ids are kept rather than pruned: a promo removed from the
       * registry today can return under the same id, and the person's answer
       * should still stand.
       */
      promos: z
        .object({
          dismissedIds: z
            .array(z.string())
            .default(() => [])
            .describe('Promo ids the user has dismissed'),
        })
        .default(() => ({ dismissedIds: [] })),
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
       * Where each mini app's right-panel tab shows (spec `mini-app-placement`):
       * one saved choice per tab, keyed by `tab` (`<extensionId>:<tabId>`). A
       * tab with no entry follows its mini app's declared default, or shows
       * everywhere. Shared by everyone using this DorkOS.
       *
       * A list rather than a record because `PATCH /api/config` replaces lists
       * and deep-merges objects: with a record, removing one tab's choice
       * ("Reset") could not be written at all.
       */
      panelTabs: z.array(SavedPlacementSchema).default(() => []),
      /** Owner-qualified Community order and remembered destinations; never draft content. */
      communityNavigation: CommunityNavigationPrefsSchema.default(() => ({
        version: 1 as const,
        owners: [],
      })),
      /**
       * When this person saw the one-time "agents now work without asking"
       * notice, or answered the onboarding statement that replaces it, as an
       * ISO 8601 string (ADR 261006-225605). `null` until then, and the notice
       * shows while it is `null` on a Trusted install.
       *
       * Gates a notice and nothing else: it grants no capability. Operator-only
       * to write, so an agent cannot dismiss a notice meant for a person.
       */
      trustNoticeSeenAt: z.string().datetime().nullable().default(null),
      /**
       * Whether a chat with one agent reads like a direct message: the room's
       * header, messages and composer over the agent's Direct chat (DOR-3074).
       * An experiment, off until a person turns it on.
       */
      dmView: z.boolean().default(false),
      /**
       * Whether the working session behind a chat can be opened: its model,
       * account, permissions and context. For everyone using this DorkOS, off by
       * default. Operator-only: an agent could otherwise hide the readings
       * about its own work.
       */
      showSessions: z.boolean().default(false),
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
      promos: { dismissedIds: [] },
      shapes: {
        active: null,
        agentDefaults: {},
        autoFollowAgent: false,
      },
      statusBar: { pins: [] },
      composer: { richText: true },
      panelTabs: [],
      communityNavigation: { version: 1 as const, owners: [] },
      // Declared here as well as per-field because `conf` merges top-level
      // defaults SHALLOWLY: the per-field default is what a fresh install lands
      // on, this literal is what an install with no stored `ui` block lands on,
      // and a field declared in only one of the two is a silent disagreement.
      trustNoticeSeenAt: null,
      dmView: false,
      showSessions: false,
    })),
  /**
   * How DorkOS gets your attention, and how hard it tries.
   *
   * One block, because the answers belong together: a person deciding "how loud
   * should this be?" should not have to find three settings in three places. It
   * is also the reason these are config and not browser storage — how loud your
   * agents may be is a fact about you, not about the laptop you happened to open
   * (the same argument `ui.promos.dismissedIds` makes next door).
   */
  notifications: NotificationPrefsSchema.default(() => ({
    escalation: { phoneAfterMinutes: 2 as const },
    sounds: { knock: true, allClear: true, turnEnd: false },
    notifyOnTurnCompleteWhileAway: true,
    browserPermissionPrimerDismissed: false,
  })),
  logging: LoggingConfigSchema.default(() => ({
    level: 'info' as const,
    maxLogSizeKb: 500,
    maxLogFiles: 14,
  })),
  relay: RelaySettingsSchema,
  /** Persistent local Linux computer opt-in. Setup begins only on a person's request. */
  computers: z.object({ enabled: z.boolean().default(false) }).default(() => ({ enabled: false })),
  /** Shared browser opt-in. A stored choice does not establish mode readiness. */
  browser: z.object({ enabled: z.boolean().default(false) }).default(() => ({ enabled: false })),
  /**
   * Spaces: joining, starting and running shared spaces (the code calls them
   * communities) with other people and their agents.
   *
   * An experiment, OFF by default (DOR-2740): the launch ships without spaces,
   * so every space surface — the switcher rows, the remote rooms, hosting, the
   * `/api/communities`, `/api/community-connections` and
   * `/api/cloud/communities` routes — stays hidden or refuses until a person
   * turns this on in Settings → Experiments. This machine's own rooms and
   * #team are not spaces and never read it. Read on every request, so a change
   * takes effect at once.
   *
   * `official.url` is the one exception (spec `official-community-space` D4):
   * the public link of the official DorkOS space. Its row shows, and it can be
   * joined, even with the experiment off. `''` turns the exception off, which
   * is the shipped default until that space exists. `DORKOS_OFFICIAL_SPACE_URL`
   * overrides it. Only a person may change it: it decides which outside server
   * this install talks to with spaces off.
   */
  spaces: SpacesSettingsSchema,
  /**
   * Chatting with this computer's agents from the web, through the owner's own
   * DorkOS in the cloud (spec `everything-is-a-space` step B3, DOR-2946).
   *
   * An experiment, OFF by default: while it is off `/api/session-relay`
   * answers 404, the Settings section is hidden, and this computer never dials
   * its hub even with a link saved. The link itself, its level and its pause
   * live in the relay's own file (`session-relay/pin.json`), never here, so no
   * config write can link a computer or raise what the web may do. Read on
   * every request, so a change takes effect at once.
   */
  sessionRelay: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default(() => ({ enabled: false })),
  /**
   * Docs: markdown documents people and agents write together, with embeds,
   * wiki links, comments and live editing (DOR-2981 to DOR-2984).
   *
   * An experiment, OFF by default: while it is off the `/api/documents`
   * routes answer 404 and the canvas editor gets no embed components, wiki
   * link resolution, comments or live editing (the editor still parses the
   * `::name` and `[[link]]` syntax either way). Read on every request, so a
   * change takes effect at once. It joins Settings → Experiments with the
   * first Docs feature; graduation is DOR-2993.
   */
  docs: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default(() => ({ enabled: false })),
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
      /**
       * How many scheduled runs may be in flight at once.
       *
       * Ships `4` (spec `full-power-defaults`, D1). One at a time meant a slow
       * run held up every schedule behind it; four is a throttle set off the
       * floor of its own range, not a capability grant — nothing about what a
       * run may do changes, and the bounds `1–10` are unchanged. Both
       * declarations of this value have to agree, here and in the section
       * literal below, because `conf` merges top-level defaults shallowly.
       */
      maxConcurrentRuns: z.number().int().min(1).max(10).default(4),
      retentionCount: z.number().int().min(1).default(100),
    })
    .default(() => ({
      enabled: true,
      maxConcurrentRuns: 4,
      retentionCount: 100,
    })),
  /** Whether this computer may idle-sleep while agents work (`config-sections.ts`). */
  keepAwake: KeepAwakeConfigSchema,
  /** Whether agents wake on their own (`config-sections.ts`). */
  heartbeats: HeartbeatsConfigSchema,
  /** The Activity feed (`config-sections.ts`). */
  activity: ActivityConfigSchema,
  mesh: z
    .object({
      scanRoots: z.array(z.string()).default(() => []),
    })
    .default(() => ({ scanRoots: [] })),
  rooms: RoomsConfigSchema,
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
  // Parsed from the section's own schema rather than restated as a literal, so
  // a field added above can never be missing from a fresh install's section.
  onboarding: OnboardingStateSchema.default(() => OnboardingStateSchema.parse({})),
  tours: ToursStateSchema.default(() => ({ seen: [], declined: [] })),
  /** Who the user is, in their own words. Local-only — see {@link UserProfileSchema}. */
  profile: UserProfileSchema.default(() => ({
    roles: [],
    tools: [],
    displayName: null,
    displayNameSource: null,
    rolePromptDismissedAt: null,
    identityPromptDismissedAt: null,
    timezone: null,
    workingHours: null,
    away: null,
  })),
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
  /**
   * Where your agents keep what they remember (spec `agent-memory`, D7).
   *
   * `MemoryProvider` is a swappable port, so the backend behind an agent's
   * memory can be something other than the markdown file DorkOS ships with — a
   * vector store, a hosted memory service. This is the one setting that
   * chooses.
   */
  memory: z
    .object({
      /**
       * Which memory backend serves every agent on this machine.
       *
       * `'builtin'` is the file you can open: one small `MEMORY.md` beside each
       * agent, on this machine and nowhere else. Any other value names a
       * backend something registered, and an id nothing registered falls back
       * to `'builtin'` with one warning rather than leaving agents with no
       * memory at all — memory is never allowed to take down a turn.
       */
      provider: z.string().min(1).default(BUILTIN_MEMORY_PROVIDER_ID),
    })
    .default(() => ({ provider: BUILTIN_MEMORY_PROVIDER_ID })),
  extensions: ExtensionsConfigSchema,
  mcp: McpConfigSchema,
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
       * first-run consent dialog from asking again for any channel.
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
       * (never the first-run consent dialog); the notice-before-send gate does not apply.
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
       * choice in the account-link flow (never the first-run consent dialog); the env
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
       * explicit opt-in (never the first-run consent dialog); the notice-before-send gate
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
  workspace: WorkspaceConfigSchema,
  harness: HarnessConfigSchema,
  workbench: WorkbenchConfigSchema,
  runtimes: RuntimesConfigSchema,
  auth: AuthConfigSchema,
  /** What agents may do, by area. See {@link PermissionsSettingsSchema}. */
  permissions: PermissionsSettingsSchema,
  cloud: CloudConfigSchema,
  /**
   * Connector gateway settings (connector-completion spec). `rawMcpServers`
   * lists the remote MCP servers the raw-MCP connector offers as connectable
   * services; the provider registers at boot with whatever is here — including
   * the empty list, so the seam is live before anyone configures a server.
   */
  connectors: ConnectorsConfigSchema,
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
