/**
 * What the Heartbeat page reads (spec `heartbeats` §7.6): how an agent wakes,
 * its next beat, its last beats from the record, and the raises held for
 * people's hours. `GET /api/agents/:id/heartbeat` answers with it.
 *
 * - **The same settings the runner uses.** An invalid header shows the last
 *   valid one in force, and `fileError` says why the file does not read.
 * - **The next report** says who reads it, when it runs and how many things it
 *   covers so far (§9.3).
 * - **Private parts stay private.** The words of a held raise go only to the
 *   person it is held for (the owner, the one person a raise can reach today);
 *   anyone else sees that it is held, not what it says. Which chat a beat ran in
 *   is the owner's to see, like every chat.
 *
 * @module services/heartbeats/heartbeat-status
 */
import {
  resolveHeartbeatSettings,
  type BeatKind,
  type BeatOutcome,
  type HeartbeatChecks,
  type HeartbeatStatus,
  type RaiseRung,
} from '@dorkos/shared/heartbeat-schemas';
import type { BeatAgent, BeatRunner } from './beat-runner.js';
import { frontmatterInForce } from './beat-plan.js';
import type { HeartbeatStore } from './heartbeat-store.js';
import type { RaiseStore } from './raises/raise-store.js';
import { reportMaterial } from './raises/report-material.js';
import { readHeartbeatFile } from './heartbeat-file.js';

/** How many past beats the page lists. */
export const STATUS_BEATS = 20;

/** What the status reads. */
export interface HeartbeatStatusInput {
  /** The agent, or undefined when no such agent exists. */
  agent: BeatAgent | undefined;
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** The runner, for the next beat and report. */
  runner: Pick<BeatRunner, 'nextBeatAt' | 'nextReportAt'>;
  /** The report queue. */
  raises: Pick<RaiseStore, 'queuedItems' | 'turnSummariesSince'>;
  /** Who the agent reports to. */
  managerOf(agentId: string): string;
  /** `heartbeats.enabled`. */
  enabled: boolean;
  /** Whether a runtime id is one this server runs. */
  runtimeRegistered(runtime: string): boolean;
  /** Whether an account id names an agent, so only raises to people are listed. */
  isAgent(accountId: string): boolean;
  /** Whether the person asking owns this install. */
  viewerIsOwner: boolean;
  /** Where its cheap checks run and what they used today (`triage/triage-checks.ts`). */
  checks(agent: BeatAgent, viewerIsOwner: boolean): Promise<HeartbeatChecks>;
}

/**
 * Build an agent's heartbeat status, or undefined when there is no such agent.
 *
 * @param input - The agent and what the status reads.
 */
export async function heartbeatStatus(
  input: HeartbeatStatusInput
): Promise<HeartbeatStatus | undefined> {
  const { agent, store, viewerIsOwner } = input;
  if (!agent) return undefined;
  const read = await readHeartbeatFile(agent.projectPath);
  const stored = store.getState(agent.id)?.lastValidFrontmatter;
  const settings = resolveHeartbeatSettings(frontmatterInForce(read, stored));
  const skippedReason = !input.enabled
    ? 'Heartbeats are off.'
    : !input.runtimeRegistered(agent.runtime)
      ? `Runs on "${agent.runtime}", which DorkOS does not run here.`
      : settings.wake === 'off'
        ? 'Heartbeat off.'
        : null;
  const next = input.runner.nextBeatAt(agent.id);
  const nextReport = input.runner.nextReportAt(agent.id);
  const lastReportAt = store.getState(agent.id)?.lastReportAt ?? null;
  return {
    enabled: input.enabled,
    wake: settings.wake,
    nextBeatAt: next ? next.toISOString() : null,
    skippedReason,
    fileError: read.kind === 'invalid' ? read.error : null,
    lastBeats: store.lastBeats(agent.id, STATUS_BEATS).map((beat) => ({
      id: beat.id,
      startedAt: beat.startedAt,
      endedAt: beat.endedAt,
      kind: beat.kind as BeatKind,
      wake: beat.wake,
      outcome: (beat.outcome ?? 'skipped') as BeatOutcome,
      summary: beat.summary ?? '',
      raises: beat.raises,
      sessionId: viewerIsOwner ? beat.turnSessionId : null,
    })),
    held: store
      .heldFor(agent.id)
      .filter((row) => !input.isAgent(row.toAccount))
      .map((row) => ({
        id: row.id,
        to: row.toAccount,
        rung: row.rung as RaiseRung,
        text: viewerIsOwner ? row.text : null,
        deliverAfter: row.deliverAfter,
        createdAt: row.createdAt,
      })),
    report: {
      cadence: settings.report,
      to: input.managerOf(agent.id),
      nextReportAt: nextReport ? nextReport.toISOString() : null,
      // What this report will carry, counted the way the report beat reads it.
      items: reportMaterial(input.raises, {
        agentId: agent.id,
        reader: input.managerOf(agent.id),
        lastReportAt,
        cadence: settings.report,
        now: Date.now(),
      }).count,
    },
    checks: await input.checks(agent, viewerIsOwner),
  };
}
