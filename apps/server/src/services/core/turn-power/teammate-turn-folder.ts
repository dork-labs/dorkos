/**
 * Where Claude Code stands for a turn a teammate in a shared space started (DOR-2956): an empty
 * folder of its own, one per agent, under the system's temporary folder, instead of the agent's
 * home. On macOS and Linux that path names no person; on Windows it is under the person's profile.
 *
 * Claude Code tells the model where it stands in an environment note it writes itself, and reads
 * without asking inside that folder. Standing at the agent's home would name the owner's folder to
 * the teammate and put its files one tool call away. Everything else about the turn (who it runs
 * as, which account pays, the boundary check) still keys on the agent's home; only the process's
 * own folder moves.
 *
 * A conversation keeps its transcript where it began: a turn resumed from this folder writes to the
 * file under the home's project folder (measured on the pinned binary). A conversation that BEGINS
 * with a teammate's turn is filed under this folder's project folder instead, so the transcript
 * reader looks there too (`teammateTranscriptFolder`).
 *
 * @module services/core/turn-power/teammate-turn-folder
 */
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The empty folder one agent's teammate turns stand in, made when missing. Under the system's
 * temporary folder, which names no person on macOS (`/var/folders/…`) and Linux (`/tmp`); on
 * Windows it sits under the person's own profile folder.
 *
 * @param agentHome - The agent's home, or `undefined` for a turn that resolved no agent.
 */
export function teammateTurnFolder(agentHome: string | undefined): string {
  const folder = teammateTurnFolderPath(agentHome);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/**
 * Where {@link teammateTurnFolder} puts one agent's folder, without making it.
 *
 * @param agentHome - The agent's home, or `undefined`.
 */
export function teammateTurnFolderPath(agentHome: string | undefined): string {
  // By the home's realpath, so the launch and the transcript reader name the same folder however
  // each spells the home.
  const digest = createHash('sha256')
    .update(agentHome ? canonical(agentHome) : '')
    .digest('hex')
    .slice(0, 16);
  return path.join(realpathSync(os.tmpdir()), 'dorkos-teammate-turns', digest);
}

/** A path by its realpath when it exists, else as given. */
function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}
