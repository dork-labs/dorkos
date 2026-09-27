/**
 * The `rooms` suite's CREDENTIALED probe of a room with files of its own (spec
 * `agent-home-desk` §5, §13).
 *
 * A room turn stands in the agent's own folder and reaches its copy of the
 * room's files through a folder grant, so the agent has to work on them by FULL
 * PATH and run git as `git -C <copy>`. The risk the spec names is an agent that
 * edits a relative path — which lands in its own home — believing it is working
 * on the room's files. Only a real model can show whether the context block and
 * the `working-in-room-repos` skill teach it well enough, so this is an outcome
 * probe on the filesystem, never on the reply: the file is in the agent's copy,
 * committed on its branch, and NOT in its home.
 *
 * `claude-code-cheap` and `quarantined`, like every credentialed rooms case: it
 * reports and never gates until green evidence promotes it.
 *
 * @module evals/suite/rooms-files
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { postToRoom } from '../runner/room-drive.js';
import type { EvalCase, Oracle, RoomScriptResult } from '../types.js';
import { roomTurnRanFor } from '../oracles/rooms.js';
import {
  agentDir,
  agentSpoke,
  CREDENTIALED_CEILING_USD,
  CREDENTIALED_QUIET_MS,
  CREDENTIALED_TIMEOUT_MS,
  mentionOf,
  openRoomFor,
  seedRoomAgents,
  type RoomAgentSpec,
} from './rooms-setup.js';

const run = promisify(execFile);

/** The agent the case asks, seated so only a mention triggers it. */
const ADA: RoomAgentSpec = {
  slug: 'ada',
  displayName: 'Ada',
  description: 'Keeps the release notes for this room up to date.',
  responseMode: 'mention-only',
};

/** The file the agent is asked to write, and a line no model could guess. */
const FILE = 'RELEASE-NOTES.md';
const CODE_LINE = 'Blue heron ships on Thursday.';

/**
 * Give the room files of its own: switch the feature on for this sandbox, then
 * ask for them as the operator does.
 *
 * @param baseUrl - The running harness server.
 * @param roomId - The room.
 */
async function giveRoomFiles(baseUrl: string, roomId: string): Promise<void> {
  const config = await fetch(`${baseUrl}/api/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rooms: { repo: { enabled: true } } }),
  });
  if (!config.ok) {
    throw new Error(`could not switch room files on: ${config.status} ${await config.text()}`);
  }
  const repo = await fetch(`${baseUrl}/api/rooms/${roomId}/repo`, { method: 'POST' });
  if (!repo.ok) {
    throw new Error(`could not give the room files: ${repo.status} ${await repo.text()}`);
  }
}

/**
 * Oracle: the agent's copy of the room's files holds the line, committed on its
 * own branch — and the agent's home holds no such file.
 */
function editedTheRoomCopyByPath(): Oracle {
  const label = `the line is committed in Ada's copy of the room's files, and not in her home`;
  return async (ctx) => {
    if (!ctx.room) {
      return { label, passed: false, detail: 'no room was driven', evidence: {} };
    }
    const worktrees = path.join(ctx.sandbox.dorkHome, 'rooms', ctx.room.roomId, 'worktrees');
    let copies: string[] = [];
    try {
      copies = (await readdir(worktrees)).map((name) => path.join(worktrees, name));
    } catch {
      // No copy was ever made: the turn never reached the room's files.
    }
    const copy = copies.find((dir) => path.basename(dir).startsWith('ada-'));
    const inCopy = copy ? await readFile(path.join(copy, FILE), 'utf-8').catch(() => null) : null;
    let committed: string | null = null;
    if (copy) {
      committed = await run('git', ['-C', copy, 'show', `HEAD:${FILE}`])
        .then((r) => r.stdout)
        .catch(() => null);
    }
    const inHome = await stat(path.join(agentDir(ctx.sandbox, 'ada'), FILE)).then(
      () => true,
      () => false
    );
    const passed =
      inCopy !== null &&
      inCopy.includes(CODE_LINE) &&
      committed !== null &&
      committed.includes(CODE_LINE) &&
      !inHome;
    return {
      label,
      passed,
      evidence: { copy: copy ?? null, inCopy, committed, inHome },
      detail: passed
        ? undefined
        : inHome
          ? `the file landed in the agent's own folder, not in its copy of the room's files`
          : `the line is not committed in the agent's copy of the room's files`,
    };
  };
}

/**
 * Files-01 — a room turn edits a room file by its full path, from home.
 */
export const roomsFilesEditByPathCase: EvalCase = {
  id: 'rooms-files-edit-by-path',
  title: 'Rooms Files-01 — a turn at home edits and commits a room file by its full path',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'release',
      title: 'release',
      agents: [ADA],
      timeoutMs: CREDENTIALED_TIMEOUT_MS,
    });
    try {
      await giveRoomFiles(ctx.baseUrl, room.roomId);
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text:
          `${mentionOf(room, 'ada')} please add a file called ${FILE} to this room's files ` +
          `containing exactly the line "${CODE_LINE}", and commit it on your branch. ` +
          'No need to merge it yet.',
      });
      const frames = await stream.settle({
        settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
        quietMs: CREDENTIALED_QUIET_MS,
      });
      return { frames, room };
    } finally {
      stream.close();
    }
  },
  oracles: [roomTurnRanFor('ada', 'the request triggered a turn'), editedTheRoomCopyByPath()],
};

/** The credentialed room-files cases, spread into the policed tier array. */
export const roomsFilesCases: EvalCase[] = [roomsFilesEditByPathCase];
