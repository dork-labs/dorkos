/**
 * What the Heartbeat page reads (spec `heartbeats` §7.6): how an agent wakes,
 * its next beat, its last beats from the record, and the raises held for
 * people's hours. `GET /api/agents/:id/heartbeat` answers with it.
 *
 * - **The same settings the runner uses.** An invalid header shows the last
 *   valid one in force, and `fileError` says why the file does not read.
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
  type HeartbeatStatus,
  type RaiseRung,
} from '@dorkos/shared/heartbeat-schemas';
import type { BeatAgent, BeatRunner } from './beat-runner.js';
import { frontmatterInForce } from './beat-plan.js';
import type { HeartbeatStore } from './heartbeat-store.js';
import { readHeartbeatFile } from './heartbeat-file.js';

/** How many past beats the page lists. */
export const STATUS_BEATS = 20;

/** What the status reads. */
export interface HeartbeatStatusInput {
  /** The agent, or undefined when no such agent exists. */
  agent: BeatAgent | undefined;
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** The runner, for the next beat. */
  runner: Pick<BeatRunner, 'nextBeatAt'>;
  /** `heartbeats.enabled`. */
  enabled: boolean;
  /** Whether a runtime id is one this server runs. */
  runtimeRegistered(runtime: string): boolean;
  /** Whether an account id names an agent, so only raises to people are listed. */
  isAgent(accountId: string): boolean;
  /** Whether the person asking owns this install. */
  viewerIsOwner: boolean;
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
  };
}
