import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS,
  COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS,
} from '@dorkos/shared/community-wire';
import type { RemoteCommunityMember } from '@dorkos/shared/community-views';
import { json, type Desktop } from './desktop.js';

/**
 * Agent availability as one person's app sees it (DOR-2877, DOR-2878): each
 * app reports its enrolled agents to the space, and every member's list shows
 * an agent as "Available" or "Offline since …".
 *
 * Showing "Offline" for real takes the space's whole threshold
 * ({@link COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS}, six minutes) after the last
 * report, too long for this journey. So the offline check reads the space's
 * member list instead: while one app is closed, its agent's `lastSeenAt` stops
 * moving, over a window in which a running app always reports again, and the
 * other app's agent, still running, moves on in that same window.
 *
 * @module community-two-desktop/availability
 */

/**
 * How long the closed app's agent must stay unreported, from its last recorded
 * report: the longest wait between two reports (the space's interval plus the
 * reporter's 10% spread), plus room for the request itself. A running app is
 * always recorded again inside it, since the space skips a write only for a
 * report under half an interval after the last.
 */
export const SILENT_FOR_MS = (COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS * 1.1 + 18) * 1000;

/**
 * One agent's row in a channel's member list, read through a person's app,
 * which asks the space for availability when the space has the feature.
 *
 * @param viewer - The app whose person reads the list.
 * @param ref - That app's connection to the space.
 * @param roomId - The channel.
 * @param memberId - The agent's member id on the space.
 */
export async function agentRow(
  viewer: Desktop,
  ref: string,
  roomId: string,
  memberId: string
): Promise<RemoteCommunityMember | undefined> {
  const { members } = await json<{ members: RemoteCommunityMember[] }>(
    `${viewer.origin}/api/communities/${ref}/rooms/${roomId}/members`
  );
  return members.find((member) => member.memberId === memberId);
}

/**
 * Wait until a person's app reads an agent as available, and return its row.
 * The first report goes out 2-10 s after an app starts reporting, so 30 s is
 * plenty for an agent enrolled moments before.
 *
 * @param viewer - The app whose person reads the list.
 * @param ref - That app's connection to the space.
 * @param roomId - The channel the agent is in.
 * @param memberId - The agent's member id on the space.
 * @throws When the space never reports the agent as available, naming what it said instead.
 */
export async function waitUntilAvailable(
  viewer: Desktop,
  ref: string,
  roomId: string,
  memberId: string
): Promise<RemoteCommunityMember> {
  let row: RemoteCommunityMember | undefined;
  await expect
    .poll(async () => (row = await agentRow(viewer, ref, roomId, memberId))?.availability, {
      timeout: 30_000,
      message:
        'the agent reads as available (no availability at all means the space lacks the agentAvailability feature)',
    })
    .toBe('available');
  assert(row?.lastSeenAt, 'an available agent has a last report time');
  return row;
}

/** What the space said about two agents while one of their apps was closed. */
export interface SilenceWatch {
  /** The closed app's agent's last report, read just after the app closed. */
  silentLastSeenAt: string;
  /** The same field at the end of the window: unchanged when the app stayed quiet. */
  silentLastSeenAtAfter: string | null;
  /** The running app's agent's last report when the window opened, and when it closed. */
  controlLastSeenAt: { before: string; after: string | null };
  /** How long the window lasted. */
  waitedMs: number;
  /** When the space will read the closed app's agent as offline, if it stays closed. */
  offlineFrom: string;
}

/**
 * Watch the space while one app is closed. Call it just after the app closes.
 * It waits until {@link SILENT_FOR_MS} has passed since the closed app's
 * agent's last report and the running app's agent has been reported again, so
 * the window is one in which the closed app would have reported had it been
 * running. That is at most about two and a half minutes.
 *
 * @param viewer - The running app, whose person reads the list.
 * @param ref - That app's connection to the space.
 * @param roomId - A channel both agents are in.
 * @param agents - The closed app's agent and the running app's agent, by member id.
 * @throws When either agent was never reported, or the window never closes.
 */
export async function watchWhileClosed(
  viewer: Desktop,
  ref: string,
  roomId: string,
  agents: { silent: string; control: string }
): Promise<SilenceWatch> {
  const started = Date.now();
  // A report the app sent just before it quit may still be landing; let it, so it counts as before.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const lastSeen = async (memberId: string) =>
    (await agentRow(viewer, ref, roomId, memberId))?.lastSeenAt ?? null;
  const silentLastSeenAt = await lastSeen(agents.silent);
  const controlBefore = await lastSeen(agents.control);
  assert(silentLastSeenAt, 'the closed app had reported its agent before it closed');
  assert(controlBefore, 'the running app has reported its agent');
  const quietUntil = Date.parse(silentLastSeenAt) + SILENT_FOR_MS;
  let controlAfter: string | null = null;
  await expect
    .poll(
      async () => {
        controlAfter = await lastSeen(agents.control);
        return Date.now() >= quietUntil && controlAfter !== controlBefore;
      },
      { timeout: SILENT_FOR_MS + 60_000, intervals: [5_000] }
    )
    .toBe(true);
  return {
    silentLastSeenAt,
    silentLastSeenAtAfter: await lastSeen(agents.silent),
    controlLastSeenAt: { before: controlBefore, after: controlAfter },
    waitedMs: Date.now() - started,
    offlineFrom: new Date(
      Date.parse(silentLastSeenAt) + COMMUNITY_AGENT_AVAILABLE_WITHIN_SECONDS * 1000
    ).toISOString(),
  };
}
