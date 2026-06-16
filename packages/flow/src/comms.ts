/**
 * Comms routing (§5) — the typed answer to "when the calibration ladder
 * (task 2.1) decides to **stop-and-ask**, _how_ does the agent reach the human?".
 *
 * The calibration ladder decides *whether* to involve a human; this module
 * decides the **channel**. The two are orthogonal: the ladder yields a
 * `stop-and-ask` behavior, and {@link resolveCommsChannel} maps the *trigger
 * that started the run* onto one of two channels:
 *
 * - **`interactive`** — a CLI run with a live terminal/session. The agent asks
 *   inline via `AskUserQuestion`; the human answers in the same breath, the loop
 *   never parks. This is the `/flow` / `/flow:<stage>` / `/flow auto`
 *   foreground experience.
 * - **`comment-and-assign`** — a PM-driven (Pulse tick) or away run with no live
 *   session. The agent runs the adapter's `needsInput` primitive: post a comment
 *   carrying the `identity.marker`, apply `agent/needs-input`, assign the issue
 *   to the human, and **stop**. It resumes only when the human replies, surfaced
 *   by `getInbox` (and read back by the comment-response rules,
 *   {@link shouldRespondToComment}).
 *
 * ## Trigger source ⟂ execution mode (the §2 orthogonality)
 *
 * The *trigger* (manual CLI vs PM-driven) is orthogonal to the *execution mode*
 * (step vs autonomous). `/flow auto` is **manual + autonomous**: it drains the
 * queue autonomously yet is a live terminal session, so its comms channel is
 * `interactive` — the human is right there. A Pulse tick is **PM-driven +
 * autonomous** with no live session, so it routes to `comment-and-assign`. The
 * channel keys off `liveSession`, never off the autonomy of the run.
 *
 * ## Config-overridable
 *
 * `involvement.comms` defaults to `"infer-from-trigger"` (the behavior above).
 * An operator who sets it to `"concise"` / `"verbose"` is choosing a *tone*, not
 * a *channel* — the channel still infers from the trigger. The override surface
 * that *does* change the channel is a future addition; today the only knob that
 * affects routing is the live-session signal on the trigger. The optional
 * out-of-band {@link CommsRoute.nudge} flags (`involvement.nudge`) ride alongside
 * either channel as a courtesy ping (Relay / Telegram), never as the primary ask.
 *
 * **This module is the pinned oracle**, mirroring the prose comms rules the v1
 * stage skills follow, and is the P5 promotion surface (the server build calls it
 * directly). Every behavior is driven from {@link InvolvementSchema} config so
 * re-tuning comms is a config edit, never a code change.
 *
 * @see specs/unified-workflow-system/02-specification.md §5 (comms channel)
 * @see .agents/flow/skills/linear-adapter/SKILL.md (`needsInput`, `getInbox`)
 * @module @dorkos/flow/comms
 */

import type { z } from 'zod';
import type { InvolvementSchema, NudgeSchema } from './config-schema.js';

/** Resolved {@link InvolvementSchema} config — comms tone, calibration, nudge. */
export type InvolvementConfig = z.infer<typeof InvolvementSchema>;
/** Resolved {@link NudgeSchema} config — the out-of-band courtesy-ping channels. */
export type NudgeConfig = z.infer<typeof NudgeSchema>;

/**
 * The two comms channels the engine can route a `stop-and-ask` through (§5):
 * - `interactive` — ask inline via `AskUserQuestion` (live CLI session).
 * - `comment-and-assign` — `needsInput`: comment + `agent/needs-input` + assign
 *   to human + stop; resume on their reply.
 */
export type CommsChannel = 'interactive' | 'comment-and-assign';

/**
 * The trigger that started the run — the input the channel infers from (§2, §5).
 * The two axes are independent: `source` is *who* started the run (a human at a
 * CLI vs a PM-driven Pulse tick), `liveSession` is *whether a terminal is
 * attached right now*. `/flow auto` is `{ source: 'manual', liveSession: true }`;
 * a Pulse tick is `{ source: 'pm-driven', liveSession: false }`.
 */
export interface CommsTrigger {
  /** Who started the run: a human at a terminal, or a PM-driven poller. */
  source: 'manual' | 'pm-driven';
  /**
   * Whether a live interactive session is attached. When `true` the agent can
   * ask inline; when `false` it must route through the tracker. A manual run
   * with no attached terminal (the "away" case) routes like a PM-driven run.
   */
  liveSession: boolean;
}

/**
 * The resolved comms route — the channel plus the out-of-band nudge flags that
 * ride alongside it. The nudge flags are echoed from config so the caller can
 * fire a courtesy ping (Relay / Telegram) without re-reading config.
 */
export interface CommsRoute {
  /** The primary channel to reach the human through. */
  channel: CommsChannel;
  /**
   * Out-of-band courtesy-ping channels (`involvement.nudge`). Echoed so the
   * caller fires a Relay/Telegram nudge alongside the primary ask. Both default
   * `false`; a nudge is never the primary ask, only an additional signal.
   */
  nudge: NudgeConfig;
}

/**
 * Resolve the comms channel for a `stop-and-ask` decision (§5) from the trigger
 * that started the run, honoring `involvement.comms` and echoing
 * `involvement.nudge`.
 *
 * The rule is single and config-driven: a live CLI session asks **interactively**
 * (`AskUserQuestion`); a PM-driven or away run posts a **comment and assigns**
 * (`needsInput` → `agent/needs-input` → assign-to-human → resume on reply). The
 * autonomy of the run (step vs autonomous, §2) never enters the decision — only
 * whether a human is reachable right now does. This keeps `/flow auto`
 * (manual + autonomous, live terminal) interactive while a Pulse tick
 * (PM-driven + autonomous, no terminal) routes to the tracker.
 *
 * `involvement.comms` is `"infer-from-trigger"` by default (the rule above);
 * `"concise"`/`"verbose"` select a *tone*, not a *channel*, so they do not
 * change the routing. The returned {@link CommsRoute.nudge} carries the
 * `involvement.nudge` flags verbatim for an optional out-of-band ping.
 *
 * @param trigger - The trigger that started the run (source + live-session flag).
 * @param involvement - The resolved `involvement` config block.
 * @returns The channel to reach the human through, plus the nudge flags.
 */
export function resolveCommsChannel(
  trigger: CommsTrigger,
  involvement: InvolvementConfig
): CommsRoute {
  // The only signal that changes the CHANNEL is whether a human is reachable
  // inline right now. `comms` tone (concise/verbose) never re-routes; it tunes
  // phrasing on whichever channel infer-from-trigger picks.
  const channel: CommsChannel =
    trigger.source === 'manual' && trigger.liveSession ? 'interactive' : 'comment-and-assign';

  return { channel, nudge: involvement.nudge };
}
