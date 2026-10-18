/**
 * What the owner of a hub has allowed its agents beyond their own settings
 * (DOR-2939 part 6, `specs/everything-is-a-space/design-agent-computers.md` §3):
 *
 * - **DorkBot's setup level**: whether DorkBot, working on an agent computer,
 *   may use the hub's setup tools (`hub-setup-tools.ts`).
 * - **Pair allowances**: one-way pairs `from → to`. A turn agent `from` starts
 *   for agent `to` on another computer runs at the owner tier instead of the
 *   teammate tier (`pair-allowance.ts`).
 *
 * One file, `<data folder>/hub/setup-grants.json`, mode `0600`, written
 * atomically under a file lock, and nothing else: never a config field, so
 * `PATCH /api/config` and the agents' config tool cannot reach it. Only the
 * owner's routes write it (`routes/hub-agent-grants.ts`); no capability and no
 * MCP tool imports this module, pinned by `__tests__/setup-grants-store.test.ts`.
 * A file that cannot be read grants nothing.
 *
 * @module services/core/tool-bridge/setup-grants-store
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { RelayAgentIdSchema } from '@dorkos/shared/session-relay';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';

const FOLDER = 'hub';
const FILE = 'setup-grants.json';
const FILE_MODE = 0o600;

/** Most pair allowances the file keeps. */
export const MAX_AGENT_PAIRS = 500;

/** One one-way pair allowance. */
export const AgentPairSchema = z.strictObject({
  /** The agent that starts the turn. */
  from: RelayAgentIdSchema,
  /** The agent whose turn runs at the owner tier. */
  to: RelayAgentIdSchema,
  /** When the owner allowed it (ISO 8601). */
  grantedAt: z.string().datetime(),
});

/** See {@link AgentPairSchema}. */
export type AgentPair = z.infer<typeof AgentPairSchema>;

/** What the owner has granted, as the routes show it. */
export const SetupGrantsSchema = z.strictObject({
  /** Whether DorkBot may use the setup tools from an agent computer. */
  dorkbotSetup: z.boolean(),
  /** When the owner last turned DorkBot's setup level on, or `null`. */
  dorkbotSetupGrantedAt: z.string().datetime().nullable(),
  /** One-way pair allowances. */
  pairs: z.array(AgentPairSchema).max(MAX_AGENT_PAIRS),
});

/** See {@link SetupGrantsSchema}. */
export type SetupGrants = z.infer<typeof SetupGrantsSchema>;

/** The body that turns DorkBot's setup level on or off. */
export const DorkBotSetupBodySchema = z.strictObject({ granted: z.boolean() });

/** The body that allows a pair: two different agents, one way. */
export const AgentPairBodySchema = z
  .strictObject({ from: RelayAgentIdSchema, to: RelayAgentIdSchema })
  .refine((pair) => pair.from !== pair.to, { message: 'Two different agents' });

/** The file as stored: the grants plus the store's own format. */
const StoredGrantsSchema = SetupGrantsSchema.extend({ v: z.literal(1) });

/** Nothing granted: what a hub starts with, and what an unreadable file means. */
export const NO_SETUP_GRANTS: SetupGrants = Object.freeze({
  dorkbotSetup: false,
  dorkbotSetupGrantedAt: null,
  pairs: [],
}) as SetupGrants;

/**
 * Where the grants live.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function setupGrantsPath(dorkHome: string = resolveDorkHome()): string {
  return path.join(dorkHome, FOLDER, FILE);
}

/**
 * The grants, or {@link NO_SETUP_GRANTS} when there is no file or it cannot be
 * read. Read fresh on every call, so a change takes effect on the next tool.
 *
 * @param dorkHome - The data folder; defaults to the live one.
 */
export function readSetupGrants(dorkHome: string = resolveDorkHome()): SetupGrants {
  let text: string;
  try {
    text = fs.readFileSync(setupGrantsPath(dorkHome), 'utf8');
  } catch {
    return NO_SETUP_GRANTS;
  }
  try {
    const parsed = StoredGrantsSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const { v: _format, ...grants } = parsed.data;
      return grants;
    }
  } catch {
    // Falls through to the warning below.
  }
  logger.warn('[ToolBridge] The setup grants could not be read, so nothing is granted');
  return NO_SETUP_GRANTS;
}

/**
 * Change the grants under the file lock: read, change, write the whole file
 * atomically at `0600`.
 *
 * @param change - The new grants, from the current ones.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns The grants as now stored.
 */
async function updateSetupGrants(
  change: (current: SetupGrants) => SetupGrants,
  dorkHome: string
): Promise<SetupGrants> {
  const file = setupGrantsPath(dorkHome);
  return withFileLock(file, async (write) => {
    const next = SetupGrantsSchema.parse(change(readSetupGrants(dorkHome)));
    await write(JSON.stringify({ v: 1, ...next }), { mode: FILE_MODE });
    return next;
  });
}

/** Options shared by the writers. */
export interface SetupGrantsWriteOptions {
  /** The data folder; defaults to the live one. */
  dorkHome?: string;
  /** The clock, for tests. */
  now?: () => Date;
}

/**
 * Turn DorkBot's setup level on or off.
 *
 * @param granted - Whether DorkBot may use the setup tools.
 * @param options - The data folder and the clock.
 * @returns The grants as now stored.
 */
export function setDorkBotSetupGrant(
  granted: boolean,
  options: SetupGrantsWriteOptions = {}
): Promise<SetupGrants> {
  const now = options.now ?? (() => new Date());
  return updateSetupGrants(
    (current) => ({
      ...current,
      dorkbotSetup: granted,
      dorkbotSetupGrantedAt: granted ? now().toISOString() : null,
    }),
    options.dorkHome ?? resolveDorkHome()
  );
}

/**
 * Allow agent `from` to start full turns for agent `to`. One way only;
 * allowing a pair again keeps its first date.
 *
 * @param from - The agent that starts the turn.
 * @param to - The agent whose turn runs at the owner tier.
 * @param options - The data folder and the clock.
 * @returns The grants as now stored.
 * @throws When `from` and `to` are the same agent, or the file is full.
 */
export function allowAgentPair(
  from: string,
  to: string,
  options: SetupGrantsWriteOptions = {}
): Promise<SetupGrants> {
  if (from === to) return Promise.reject(new Error('An agent cannot be paired with itself'));
  const now = options.now ?? (() => new Date());
  return updateSetupGrants((current) => {
    if (isPairAllowed(current, from, to)) return current;
    return {
      ...current,
      pairs: [...current.pairs, { from, to, grantedAt: now().toISOString() }],
    };
  }, options.dorkHome ?? resolveDorkHome());
}

/**
 * Take a pair allowance back.
 *
 * @param from - The agent that started the turns.
 * @param to - The agent whose turns ran at the owner tier.
 * @param options - The data folder.
 * @returns The grants as now stored.
 */
export function removeAgentPair(
  from: string,
  to: string,
  options: Pick<SetupGrantsWriteOptions, 'dorkHome'> = {}
): Promise<SetupGrants> {
  return updateSetupGrants(
    (current) => ({
      ...current,
      pairs: current.pairs.filter((pair) => !(pair.from === from && pair.to === to)),
    }),
    options.dorkHome ?? resolveDorkHome()
  );
}

/**
 * Whether the owner allowed `from` to start full turns for `to`.
 *
 * @param grants - The grants.
 * @param from - The agent starting the turn.
 * @param to - The agent the turn is for.
 */
export function isPairAllowed(grants: SetupGrants, from: string, to: string): boolean {
  return grants.pairs.some((pair) => pair.from === from && pair.to === to);
}
