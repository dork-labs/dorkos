/**
 * Comms routing (§5) — the typed answer to "when the calibration ladder
 * (task 2.1) decides to **stop-and-ask**, _how_ does the agent reach the human?".
 *
 * The calibration ladder decides *whether* to involve a human; this module
 * decides the **channel**. The two are orthogonal: the ladder yields a
 * `stop-and-ask` behavior, and {@link resolveCommsChannel} maps the *trigger that
 * started the run* plus the detected {@link IdentityMode} onto one of three
 * channels:
 *
 * - **`interactive`** — a CLI run with a live terminal/session (either identity
 *   mode). The agent asks inline via `AskUserQuestion`; the human answers in the
 *   same breath, the loop never parks. This is the `/flow` / `/flow:<stage>` /
 *   `/flow auto` foreground experience.
 * - **`comment-and-assign`** — an unattended run in **two-account** mode (a Pulse
 *   tick / away run with a distinct reviewer account). The agent runs the
 *   adapter's `needsInput` primitive: post a comment carrying the
 *   `identity.marker`, apply `agent/needs-input`, assign the issue to the reviewer
 *   (whose distinct account gets a real notification), and **stop**. It resumes
 *   only when the human replies, surfaced by `getInbox` (and read back by the
 *   comment-response rules, {@link shouldRespondToComment}).
 * - **`comment-and-nudge`** — an unattended run in **shared-account** mode (agent
 *   acts *as* the human's account). Same durable record (comment +
 *   `agent/needs-input`), but the assignment notifies no one (assigning to
 *   yourself), so the out-of-band nudge (Relay / Telegram / chat) is **promoted to
 *   the primary attention channel** — see {@link CommsRoute.nudgePrimary}. It
 *   resumes the same way, on a non-agent reply disambiguated by the marker.
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
 * a *channel* — the channel still infers from the trigger + identity mode. The
 * routing inputs are the live-session signal on the trigger and the detected
 * {@link IdentityMode}; tone never re-routes. The out-of-band
 * {@link CommsRoute.nudge} flags (`involvement.nudge`) ride alongside `interactive`
 * / `comment-and-assign` as a courtesy ping (Relay / Telegram), but on
 * `comment-and-nudge` (shared mode) the nudge is **promoted to the primary** ask
 * ({@link CommsRoute.nudgePrimary}), because the tracker assignment reaches no one.
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
import type { IdentityMode } from './identity.js';

/** Resolved {@link InvolvementSchema} config — comms tone, calibration, nudge. */
export type InvolvementConfig = z.infer<typeof InvolvementSchema>;
/** Resolved {@link NudgeSchema} config — the out-of-band courtesy-ping channels. */
export type NudgeConfig = z.infer<typeof NudgeSchema>;

/**
 * The three comms channels the engine can route a `stop-and-ask` through (§5):
 * - `interactive` — ask inline via `AskUserQuestion` (live CLI session, any mode).
 * - `comment-and-assign` — `needsInput`: comment + `agent/needs-input` + assign
 *   to the reviewer + stop; resume on their reply. The **two-account** unattended
 *   channel: a distinct reviewer account means the assignment fires a real tracker
 *   notification.
 * - `comment-and-nudge` — the **shared-account** unattended channel: comment +
 *   `agent/needs-input` (the durable record) + an out-of-band nudge **promoted to
 *   the primary attention channel** (Relay / Telegram / chat). In shared mode the
 *   agent acts *as* the human's account, so `assignToHuman` is a no-op (assigning
 *   to yourself notifies no one) — the nudge, not the assignment, is what reaches
 *   the human. The `agent/needs-input` comment is still written for the durable
 *   record and the rule-3 resume.
 */
export type CommsChannel = 'interactive' | 'comment-and-assign' | 'comment-and-nudge';

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
   * Out-of-band nudge channels (`involvement.nudge`). Echoed so the caller fires a
   * Relay/Telegram nudge alongside the channel. Both default `false`. Its *role*
   * depends on {@link nudgePrimary}: a courtesy ping on `interactive` /
   * `comment-and-assign`, but the **primary attention channel** on
   * `comment-and-nudge` (shared mode).
   */
  nudge: NudgeConfig;
  /**
   * Whether the {@link nudge} IS the primary attention channel for this route
   * (not merely a courtesy ping). `true` only for `comment-and-nudge` (unattended
   * + shared mode), where the tracker assignment notifies no one because agent and
   * human share the account, so the out-of-band nudge is what actually reaches the
   * human. `false` on `interactive` and `comment-and-assign`, where the primary ask
   * is the inline question or the assignment notification respectively.
   */
  nudgePrimary: boolean;
}

/**
 * Resolve the comms channel for a `stop-and-ask` decision (§5) from the trigger
 * that started the run AND the detected {@link IdentityMode}, honoring
 * `involvement.comms` and echoing `involvement.nudge`.
 *
 * Two signals pick the channel, in order:
 *
 * 1. **Is a human reachable inline right now?** A live CLI session (manual +
 *    `liveSession`) always asks **interactively** (`AskUserQuestion`), in *either*
 *    identity mode — the human is right there, so the tracker is moot. This keeps
 *    `/flow auto` (manual + autonomous, live terminal) interactive.
 * 2. **Otherwise the run is unattended — does a distinct reviewer account exist?**
 *    The {@link IdentityMode} decides:
 *    - **`two-account`** → **`comment-and-assign`**: comment + `agent/needs-input`
 *      + assign to the distinct reviewer (the assignment fires a real
 *      notification) + stop; resume on their reply.
 *    - **`shared`** → **`comment-and-nudge`**: comment + `agent/needs-input` (the
 *      durable record) + an out-of-band nudge **promoted to primary**. In shared
 *      mode `assignToHuman` is a no-op (agent and human are one account, so the
 *      tracker notifies no one), so the nudge is the channel that actually reaches
 *      the human, not a courtesy ping.
 *
 * The autonomy of the run (step vs autonomous, §2) never enters the decision —
 * only live-reachability and identity mode do. `involvement.comms` is
 * `"infer-from-trigger"` by default; `"concise"`/`"verbose"` select a *tone*, not
 * a *channel*, so they never re-route. The returned {@link CommsRoute.nudge}
 * carries the `involvement.nudge` flags verbatim, and {@link CommsRoute.nudgePrimary}
 * marks whether the nudge is the primary channel (only on `comment-and-nudge`).
 *
 * @param trigger - The trigger that started the run (source + live-session flag).
 * @param identityMode - The detected identity mode (`resolveIdentityMode`), which
 *   splits the unattended case between assign (two-account) and nudge (shared).
 * @param involvement - The resolved `involvement` config block.
 * @returns The channel to reach the human through, the nudge flags, and whether
 *   the nudge is the primary attention channel.
 */
export function resolveCommsChannel(
  trigger: CommsTrigger,
  identityMode: IdentityMode,
  involvement: InvolvementConfig
): CommsRoute {
  // Signal 1: a live CLI session asks inline, in either identity mode — the human
  // is reachable right now, so neither the tracker assignment nor a nudge applies.
  const live = trigger.source === 'manual' && trigger.liveSession;

  // Signal 2 (unattended only): the identity mode picks the tracker channel.
  // shared → nudge is primary (assignment notifies no one); two-account → assign.
  let channel: CommsChannel;
  if (live) {
    channel = 'interactive';
  } else if (identityMode === 'shared') {
    channel = 'comment-and-nudge';
  } else {
    channel = 'comment-and-assign';
  }

  return { channel, nudge: involvement.nudge, nudgePrimary: channel === 'comment-and-nudge' };
}
