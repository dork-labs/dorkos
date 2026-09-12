/**
 * How often auto mode stops the agent on a DorkOS tool, and how often DorkOS
 * told the classifier something about one (spec `auto-mode-classifier-context`).
 *
 * ## Why both numbers live in one module
 *
 * The point of the host-context note is to remove stops that did not need to
 * happen. "Did it work?" is therefore a comparison, and a comparison needs both
 * halves read off the same clock: how many DorkOS tool calls auto mode stopped
 * on, and how many notes DorkOS attached in the same window. Two endpoints, or
 * two rings started at different moments, would give an operator two numbers
 * that cannot honestly be divided.
 *
 * The kill switch is what makes the comparison possible at all. Run a week with
 * `DORKOS_CLASSIFIER_CONTEXT` on and a week with it off, read
 * `GET /api/debug/auto-mode-stops` at the end of each, and the stop rate per
 * DorkOS tool call is the measurement.
 *
 * ## A stop, precisely
 *
 * In auto mode the runtime's own classifier decides which calls a person should
 * see. A call it waves through never reaches DorkOS's `canUseTool` at all. A
 * call it stops on does — and for a DorkOS tool that is not on the
 * `DORKOS_AGENT_TOOLS` auto-allow list, DorkOS then raises an approval card and
 * the turn makes no progress until somebody answers. That card is the stop this
 * module counts, and it is counted at the moment it is raised, not when it is
 * answered: an unanswered card costs the same attention as a denied one.
 *
 * Only `auto` is counted. `default` asks about everything by design, so counting
 * its cards would drown the signal in the mode that is supposed to produce them.
 *
 * ## Not persisted, deliberately
 *
 * These counters die with the process; the log line each record writes survives
 * it. Same argument as `phantom-cancellations.ts`: the NDJSON log is the durable
 * record and a ring written to disk is a second, worse log.
 *
 * @module services/observability/auto-mode-stops
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';

import { logger } from '../../lib/logger.js';

/** One auto-mode stop, as the counter is told about it. */
export interface AutoModeStopReport {
  /** The DorkOS session the turn belonged to. */
  sessionId: string;
  /** The qualified tool name the model called (`mcp__dorkos__tasks_delete`). */
  toolName: string;
}

/** One note DorkOS attached, as the counter is told about it. */
export interface ClassifierAssertionReport {
  /** The DorkOS session the turn belonged to. */
  sessionId: string;
  /** The registered tool name, unqualified. */
  tool: string;
  /** The tier the note asserted. */
  tier: CapabilityTier;
}

/** Everything this process has counted since it started. */
export interface AutoModeStopStats {
  /** Approval cards auto mode caused on a DorkOS tool. */
  stops: number;
  /** Stops per qualified tool name, most-stopped first is the caller's job. */
  stopsByTool: Record<string, number>;
  /** Distinct sessions that saw at least one stop. */
  stopSessions: number;
  /** Host-context notes attached to a finished DorkOS tool call. */
  assertions: number;
  /** Notes per tier — the shape of what DorkOS is asserting. */
  assertionsByTier: Record<CapabilityTier, number>;
  /** ISO 8601 — when this process started counting. */
  since: string;
}

const stopsByTool = new Map<string, number>();
const stopSessions = new Set<string>();
const assertionsByTier: Record<CapabilityTier, number> = { observe: 0, act: 0, destructive: 0 };
let stops = 0;
let assertions = 0;
let since = new Date().toISOString();

/**
 * Count one auto-mode stop on a DorkOS tool, and write the line that proves it.
 *
 * `info`, not `warn`: the operator is looking at a card right now, so nothing is
 * invisible. The line exists so the count survives the process — a week-long
 * measurement should not depend on nobody restarting the server.
 *
 * @param report - The session and the tool that was stopped on.
 */
export function recordAutoModeStop(report: AutoModeStopReport): void {
  stops += 1;
  stopsByTool.set(report.toolName, (stopsByTool.get(report.toolName) ?? 0) + 1);
  stopSessions.add(report.sessionId);
  logger.info('[auto-mode-stop] auto mode stopped the agent on a DorkOS tool', {
    session: report.sessionId,
    toolName: report.toolName,
    totalSinceBoot: stops,
  });
}

/**
 * Count one host-context note, and write the line that records what was said.
 *
 * This is the per-assertion record the spec asks for. `debug`, because a note is
 * the ordinary case and nothing is being refused or hidden — the point of the
 * line is that an operator who wants to know exactly what DorkOS asserted, and
 * about which call, can turn the level up and read it.
 *
 * The note's TEXT is deliberately not logged: it is one of three constants and
 * `tier` names which of them was sent, so logging the string would only make
 * the line longer.
 *
 * @param report - The session, the tool, and what the note asserted.
 */
export function recordClassifierAssertion(report: ClassifierAssertionReport): void {
  assertions += 1;
  assertionsByTier[report.tier] += 1;
  logger.debug('[classifier-context] told auto mode what DorkOS already decided', {
    session: report.sessionId,
    tool: report.tool,
    tier: report.tier,
    totalSinceBoot: assertions,
  });
}

/**
 * Everything counted since this process started.
 *
 * Read by `GET /api/debug/auto-mode-stops`.
 */
export function autoModeStopStats(): AutoModeStopStats {
  return {
    stops,
    stopsByTool: Object.fromEntries(stopsByTool),
    stopSessions: stopSessions.size,
    assertions,
    assertionsByTier: { ...assertionsByTier },
    since,
  };
}

/** Forget everything counted. Test isolation only — nothing in the server calls it. */
export function resetAutoModeStops(): void {
  stopsByTool.clear();
  stopSessions.clear();
  assertionsByTier.observe = 0;
  assertionsByTier.act = 0;
  assertionsByTier.destructive = 0;
  stops = 0;
  assertions = 0;
  since = new Date().toISOString();
}
