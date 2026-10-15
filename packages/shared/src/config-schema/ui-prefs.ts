/**
 * Shape and status-bar preferences that live under `ui`.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/ui-prefs
 */
import { z } from 'zod';

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
