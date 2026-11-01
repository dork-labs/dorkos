import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { agentLaunchMaxLive } from '../../session/launch/launch-session.js';

/** How much room this computer has right now, as `GET /api/config` reports it. */
export interface ServerCapacity {
  /** The cap on chats agents may run at once (`runtimes.maxAgentChats`). */
  maxAgentChats: number;
  /** One-minute load average, or `null` where the system reports none (Windows). */
  loadAverage: number | null;
  /** Free bytes on the disk holding `dir`, or `null` when it cannot be read. */
  freeDiskBytes: number | null;
}

/**
 * Read the figures the Team view's top line shows.
 *
 * A figure that cannot be read comes back `null` rather than failing the whole
 * config read, which every screen in the app depends on.
 *
 * @param dir - A directory on the disk to measure: the DorkOS data directory.
 */
export async function describeCapacity(dir: string): Promise<ServerCapacity> {
  const [load] = os.loadavg();
  let freeDiskBytes: number | null = null;
  try {
    const stats = await statfs(dir);
    freeDiskBytes = stats.bavail * stats.bsize;
  } catch {
    // Unreadable disk figure: the top line leaves it out.
  }
  return {
    maxAgentChats: agentLaunchMaxLive(),
    // Windows answers 0 always, which is "no reading", not "no load".
    loadAverage: process.platform === 'win32' ? null : load,
    freeDiskBytes,
  };
}
