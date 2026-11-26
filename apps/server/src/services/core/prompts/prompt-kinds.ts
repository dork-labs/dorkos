/**
 * The registry of prompt kinds: each kind of moment where DorkOS may ask a person before an agent
 * acts, with its default answer, where a person changes it, and the switch that changes it.
 *
 * One entry today (DOR-4794): a connected-app write back to the one app a marked turn read. The
 * server decides each kind in one place (`apps/server/src/services/core/prompts/should-ask.ts`).
 *
 * ## Floors carry no switch
 *
 * A floor kind always asks, whatever any setting says, so nothing may turn it off. The types make
 * that structural: a kind with `floor: true` cannot name a `switch`, so a floor that a setting
 * could lower does not compile. A census also checks that no floor kind's key is a config key.
 *
 * ## Switches are a person's alone
 *
 * A switch is either a key in the person's config or a field on one connected app's row. Either
 * way only a person may set it: a config switch must be an operator-only config path, and a
 * connection switch has one writer, reached only from an operator-only route. The server's
 * census test fails when a switch appears that an agent could reach.
 *
 * @module services/core/prompts/prompt-kinds
 */

/** Which part of the server decides a kind. */
export type PromptKindEngine = 'capability';

/** What a kind answers when nothing changes it. */
export type PromptDecision = 'ask' | 'allow' | 'refuse';

/** Where in Settings a person finds a kind. */
export interface PromptKindSettingsHome {
  /** The settings page. */
  readonly page: 'permissions';
  /** The group on that page. */
  readonly group: 'sending-outside';
}

/** The person's switch that changes a kind's answer: a config key, or a field on one app's row. */
export type PromptKindSwitch =
  | {
      /** A key in the person's config. Must be an operator-only config path. */
      readonly store: 'config';
      /** The config key, as a dot path. */
      readonly key: string;
    }
  | {
      /** A field on one connected app's row, set per app. */
      readonly store: 'connection';
      /** The column on `connections`, as the database names it. */
      readonly field: string;
    };

/** What every kind carries. */
interface PromptKindBase {
  /** The stable key, e.g. `connector.write.marked-same-source`. */
  readonly key: string;
  /** Which part of the server decides it. */
  readonly engine: PromptKindEngine;
  /** What it answers when no switch changes it. */
  readonly default: PromptDecision;
  /** Where a person finds it in Settings. */
  readonly settingsHome: PromptKindSettingsHome;
  /** The Activity event type written when it lets an agent act without asking. */
  readonly auditKind: string;
  /** One plain line for its row in Settings. */
  readonly rowCopy: string;
}

/** A kind a person may change, with the switch that changes it. */
export interface SwitchablePromptKind extends PromptKindBase {
  /** Not a floor. */
  readonly floor: false;
  /** The person's switch. */
  readonly switch: PromptKindSwitch;
}

/** A kind that always asks: no setting may lower it, so it names no switch. */
export interface FloorPromptKind extends PromptKindBase {
  /** A floor. */
  readonly floor: true;
  /** Never present on a floor. */
  readonly switch?: never;
}

/** One kind of prompt. */
export type PromptKind = SwitchablePromptKind | FloorPromptKind;

/** Every prompt kind, by key. */
export const PROMPT_KINDS = {
  'connector.write.marked-same-source': {
    key: 'connector.write.marked-same-source',
    engine: 'capability',
    default: 'ask',
    floor: false,
    settingsHome: { page: 'permissions', group: 'sending-outside' },
    switch: { store: 'connection', field: 'writes_back_unasked' },
    auditKind: 'agent.same_source_write',
    rowCopy: 'An agent that only read an app writes back to it without asking.',
  },
} as const satisfies Record<string, PromptKind>;

/** The key of one prompt kind. */
export type PromptKindKey = keyof typeof PROMPT_KINDS;

/** Every prompt kind's key, in registry order. */
export const PROMPT_KIND_KEYS = Object.keys(PROMPT_KINDS) as PromptKindKey[];

/**
 * One prompt kind, by key.
 *
 * @param key - The kind's key.
 */
export function promptKind(key: PromptKindKey): PromptKind {
  return PROMPT_KINDS[key];
}
