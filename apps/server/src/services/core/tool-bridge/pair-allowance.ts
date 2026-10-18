/**
 * The tier of a turn one agent starts for another on a different computer
 * (DOR-2939 part 6, `specs/everything-is-a-space/design-agent-computers.md`
 * §3, "Cross-computer turns").
 *
 * When agent A on computer X starts a turn for agent B on computer Y
 * (`session_start`, `chat_send`), B's turn runs at the teammate tier (C7,
 * `turn-power/teammate-tier.ts`) unless the owner allowed the pair A → B.
 * Allowances are one-way and live in the owner-only grants file
 * (`setup-grants-store.ts`).
 *
 * Not wired yet: the forwarding runtime (part 5) asks this when it starts a
 * cross-computer turn, and records the answer as the turn's tier on the hub.
 *
 * @module services/core/tool-bridge/pair-allowance
 */
import type { AgentComputerTurnTierSchema } from '@dorkos/shared/session-relay-agent-computer';
import type { z } from 'zod';
import { isPairAllowed, readSetupGrants, type SetupGrants } from './setup-grants-store.js';

/** The tier a turn runs at. */
export type CrossComputerTurnTier = z.infer<typeof AgentComputerTurnTierSchema>;

/**
 * `'owner'` when the owner allowed `fromAgentId` to start full turns for
 * `toAgentId`, else `'teammate'`.
 *
 * @param fromAgentId - The agent starting the turn.
 * @param toAgentId - The agent the turn is for.
 * @param grants - The grants to read; defaults to the live file, read fresh.
 */
export function tierForCrossComputerTurn(
  fromAgentId: string,
  toAgentId: string,
  grants: SetupGrants = readSetupGrants()
): CrossComputerTurnTier {
  return isPairAllowed(grants, fromAgentId, toAgentId) ? 'owner' : 'teammate';
}
