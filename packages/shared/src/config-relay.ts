import { z } from 'zod';

/**
 * The bounds the relay turn ceiling must satisfy.
 *
 * Its own constant rather than a reuse of {@link ROOM_TURN_LIMIT_BOUNDS},
 * because that object's contract is "what a per-room override must satisfy" and
 * these two numbers have no per-room form. `null` — no limit — is expressed by
 * the schema's `.nullable()`, not by a sentinel inside this range, so `0` keeps
 * its literal meaning: start no turns at all.
 */
export const RELAY_TURN_CEILING_BOUNDS = { min: 0, max: 100_000 } as const;

/**
 * What the relay turn ceiling is before anybody changes it.
 *
 * Deliberately the same pair of numbers the rooms ceiling ships with
 * ({@link ROOM_TURN_LIMIT_DEFAULTS}): a person reasoning about "how much can my
 * agents spend on their own" should not have to hold two different allowances
 * in their head because the traffic took a different pipe. They are separate
 * wallets — a busy hour in rooms does not eat the message bus's allowance — and
 * that is the honest reading of two ceilings, not a doubling of one.
 *
 * Generous but real: 5,000 turns an hour is far more than any working install
 * runs, and an A2A peer pinned at the 60/min ingress cap reaches it in 83
 * minutes instead of never. The per-agent number bites much sooner, which is
 * the point — two agents told to "keep each other posted" trade turns as fast
 * as they finish them, and 1,000 is where that stops.
 *
 * The schema below builds its `.default()` calls from this object AND its
 * object-literal block default, so the shipped value has one definition and a
 * fresh install cannot disagree with an upgraded one.
 */
export const RELAY_TURN_CEILING_DEFAULTS = {
  maxAgentTurnsPerAgentPerHour: 1000,
  maxAgentTurnsTotalPerHour: 5000,
} as const;

/** Messaging settings and their upgrade-safe defaults. */
export const RelaySettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    dataDir: z.string().nullable().default(null),
    /**
     * The most turns any ONE agent may be sent through agent messaging in an
     * hour, counted whoever asked for them.
     *
     * Every way of making an agent answer over the message bus — another
     * agent's publish, an outside system speaking A2A, a webhook posting
     * back — ends at the same dispatch, and this counts them all there. It
     * does not read who is calling, because in the shipped posture DorkOS
     * cannot reliably tell a program on your machine from you.
     *
     * `null` means no limit. `0` stops agent messaging from starting turns
     * at all.
     */
    maxAgentTurnsPerAgentPerHour: z
      .number()
      .int()
      .min(RELAY_TURN_CEILING_BOUNDS.min)
      .max(RELAY_TURN_CEILING_BOUNDS.max)
      .nullable()
      .default(RELAY_TURN_CEILING_DEFAULTS.maxAgentTurnsPerAgentPerHour),
    /**
     * The most turns agent messaging may start on this DorkOS in an hour,
     * across every agent.
     *
     * This is the ceiling on what agents messaging each other can cost you.
     * The per-agent number above keeps one runaway pair from eating the whole
     * allowance; this one is the allowance. `null` means no limit, `0` stops
     * agent messaging from starting turns at all.
     */
    maxAgentTurnsTotalPerHour: z
      .number()
      .int()
      .min(RELAY_TURN_CEILING_BOUNDS.min)
      .max(RELAY_TURN_CEILING_BOUNDS.max)
      .nullable()
      .default(RELAY_TURN_CEILING_DEFAULTS.maxAgentTurnsTotalPerHour),
  })
  .default(() => ({
    enabled: true,
    dataDir: null,
    maxAgentTurnsPerAgentPerHour: RELAY_TURN_CEILING_DEFAULTS.maxAgentTurnsPerAgentPerHour,
    maxAgentTurnsTotalPerHour: RELAY_TURN_CEILING_DEFAULTS.maxAgentTurnsTotalPerHour,
  }));
