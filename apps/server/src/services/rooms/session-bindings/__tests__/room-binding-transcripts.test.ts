/**
 * The one probe both the convergence sweep and the doctor ask (DOR-805).
 *
 * Two copies of "does this binding have a transcript" used to disagree, and this
 * file pins the answers the surviving one gives — the divergences included,
 * because "the two now agree" is only worth anything if they agree on the RIGHT
 * answer. The transcript question itself is injected here; that it is asked with
 * the agent's working directory and in the right argument order is pinned
 * against real files on disk by `room-session-repair-transcripts.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { sessionMetadata } from '@dorkos/db';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import {
  probeRoomBindingTranscript,
  surveyRoomBindingTranscripts,
  type RoomBindingTranscriptDeps,
} from '../room-binding-transcripts.js';
import type { RoomSessionBinding } from '../room-session-ledger.js';

const ANA = 'author-ana';
const ANA_PATH = '/agents/ana';
const SESSION = '0e7270c6-5555-4666-8777-888888888888';

/** One row of `room_sessions`, the way both callers hand it over. */
function binding(sessionId = SESSION, authorId = ANA): RoomSessionBinding {
  return { roomId: 'room-backend', authorId, sessionId };
}

/** Ana on the registry default runtime, with the transcript answer supplied. */
function deps(overrides: Partial<RoomBindingTranscriptDeps> = {}): RoomBindingTranscriptDeps {
  return {
    agentPathFor: (authorId) => (authorId === ANA ? ANA_PATH : null),
    hasTranscript: () => Promise.resolve(true),
    ...overrides,
  };
}

let db: ReturnType<typeof createTestDb>;
let agentDirs: string[];

beforeEach(() => {
  db = createTestDb();
  runtimeRegistry.setDb(db);
  agentDirs = [];
});

afterEach(async () => {
  await Promise.all(agentDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Record who owns a session, the way session creation does. */
function bindSessionRuntime(sessionId: string, runtime: string): void {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime, createdAt: new Date().toISOString() })
    .run();
}

/**
 * A real agent directory whose manifest names `runtime`, with that runtime
 * registered so the manifest rung answers with it rather than falling back.
 */
async function agentDirWithRuntime(runtime: string): Promise<string> {
  if (!runtimeRegistry.has(runtime)) runtimeRegistry.register(new FakeAgentRuntime(runtime));
  const dir = await mkdtemp(join(tmpdir(), 'dorkos-binding-probe-'));
  agentDirs.push(dir);
  await mkdir(join(dir, '.dork'), { recursive: true });
  await writeFile(
    join(dir, '.dork', 'agent.json'),
    JSON.stringify({
      id: 'agent-ana',
      name: 'ana',
      runtime,
      registeredAt: new Date().toISOString(),
      registeredBy: 'test',
    })
  );
  return dir;
}

describe('probeRoomBindingTranscript', () => {
  it('says present when the conversation is where a resume would look', async () => {
    const answer = await probeRoomBindingTranscript(binding(), deps());

    expect(answer).toEqual({ verdict: 'present', agentPath: ANA_PATH });
  });

  it('says missing when nothing is there, and names the agent directory', async () => {
    const answer = await probeRoomBindingTranscript(
      binding(),
      deps({ hasTranscript: () => Promise.resolve(false) })
    );

    expect(answer).toEqual({ verdict: 'missing', agentPath: ANA_PATH });
  });

  it('asks with the agent working directory and the bound session id', async () => {
    const asked: Array<[string, string]> = [];
    await probeRoomBindingTranscript(
      binding(),
      deps({
        hasTranscript: (agentPath, sessionId) => {
          asked.push([agentPath, sessionId]);
          return Promise.resolve(true);
        },
      })
    );

    // The cwd-scoped question, which is the one a resume asks. The doctor used to
    // ask a different one — "is this id under ANY project slug" — which passed an
    // agent whose project directory had moved while its room really had lost the
    // conversation.
    expect(asked).toEqual([[ANA_PATH, SESSION]]);
  });

  it('never probes a binding whose author is not an agent this install knows', async () => {
    let probed = false;
    const answer = await probeRoomBindingTranscript(
      binding(SESSION, 'author-somebody'),
      deps({
        hasTranscript: () => {
          probed = true;
          return Promise.resolve(false);
        },
      })
    );

    expect(answer).toEqual({ verdict: 'not-applicable', agentPath: null });
    expect(probed).toBe(false);
  });

  it('leaves alone a session bound to a runtime that keeps no transcript', async () => {
    // The second divergence: this session was created on codex, so there is no
    // `.jsonl` by design and calling it missing would be a false alarm.
    bindSessionRuntime(SESSION, 'codex');
    let probed = false;

    const answer = await probeRoomBindingTranscript(
      binding(),
      deps({
        hasTranscript: () => {
          probed = true;
          return Promise.resolve(false);
        },
      })
    );

    expect(answer).toEqual({ verdict: 'not-applicable', agentPath: ANA_PATH });
    expect(probed).toBe(false);
  });

  it("follows the session's own owner, not whatever the manifest says now", async () => {
    // The divergence itself: an agent whose manifest was changed to codex AFTER
    // this session started. The session was and remains a claude-code session
    // (ADR-0255), so its transcript is still this probe's business — the sweep
    // used to read the manifest and skip it, while the doctor warned about it.
    const agentPath = await agentDirWithRuntime('codex');
    bindSessionRuntime(SESSION, 'claude-code');

    const answer = await probeRoomBindingTranscript(
      binding(),
      deps({ agentPathFor: () => agentPath, hasTranscript: () => Promise.resolve(false) })
    );

    expect(answer).toEqual({ verdict: 'missing', agentPath });
  });

  it('falls to the manifest for a session nothing has bound yet', async () => {
    // The other rung of the same ladder: a room placeholder has no owner, so the
    // manifest is the answer — and a codex agent's next session will keep no
    // transcript, so there is nothing here to call missing.
    const agentPath = await agentDirWithRuntime('codex');

    const answer = await probeRoomBindingTranscript(
      binding(),
      deps({ agentPathFor: () => agentPath, hasTranscript: () => Promise.resolve(false) })
    );

    expect(answer).toEqual({ verdict: 'not-applicable', agentPath });
  });

  it('says unreadable, never missing, when the transcript could not be read', async () => {
    // "Nothing is known" and "nothing is there" are opposite answers: reporting
    // an unreadable `~/.claude/projects` as a stranded binding would tell every
    // room on the machine it had lost its memory.
    const answer = await probeRoomBindingTranscript(
      binding(),
      deps({ hasTranscript: () => Promise.reject(new Error('EACCES')) })
    );

    expect(answer).toEqual({ verdict: 'unreadable', agentPath: ANA_PATH, error: 'EACCES' });
  });

  it('says unreadable when the runtime lookup itself fails', async () => {
    runtimeRegistry.setDb(undefined as never);

    const answer = await probeRoomBindingTranscript(binding(), deps());

    expect(answer.verdict).toBe('unreadable');
  });

  it('says unreadable when the AGENT lookup throws, rather than throwing itself', async () => {
    // The third read, and the one that was outside the guard until DOR-1780.
    // `agentPathFor` looks synchronous, so it read as a map lookup — but in
    // production it is `roomAuthors.getById`, a synchronous better-sqlite3
    // `.get()` that raises on a busy, corrupt or closed database. Those are the
    // conditions under which somebody is running the doctor in the first place,
    // and the throw escaped the probe: the boot sweep lost its whole report and
    // `GET /api/debug/rooms/:id/bindings` answered 500 with the raw message.
    const answer = await probeRoomBindingTranscript(
      binding(),
      deps({
        agentPathFor: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      })
    );

    // No agent path, because resolving it is what failed.
    expect(answer).toEqual({
      verdict: 'unreadable',
      agentPath: null,
      error: 'SQLITE_BUSY: database is locked',
    });
  });
});

describe('surveyRoomBindingTranscripts', () => {
  it('separates what it judged from what it could not read', async () => {
    const live = binding('live-session');
    const dead = binding('dead-session');
    const unreadable = binding('unreadable-session');

    const survey = await surveyRoomBindingTranscripts(
      [live, dead, unreadable, binding(SESSION, 'author-somebody')],
      deps({
        hasTranscript: (_agentPath, sessionId) => {
          if (sessionId === 'unreadable-session') return Promise.reject(new Error('EACCES'));
          return Promise.resolve(sessionId === 'live-session');
        },
      })
    );

    // The unknown author is in neither count: nothing was asked about it.
    expect(survey).toEqual({ judged: 2, missing: [dead], unreadable: 1 });
  });

  it('finishes the sweep when one binding’s author row cannot be read', async () => {
    // One bad row used to abort the whole pass: the throw escaped the probe,
    // escaped this loop, and the caller — the boot sweep, or the doctor's
    // check — lost every binding after it as well as every one before
    // (DOR-1780). Now it costs exactly the row it happened on.
    const good = binding('live-session');
    const bad = binding(SESSION, 'author-corrupt');

    const survey = await surveyRoomBindingTranscripts(
      [bad, good],
      deps({
        agentPathFor: (authorId) => {
          if (authorId === 'author-corrupt') throw new Error('SQLITE_CORRUPT');
          return ANA_PATH;
        },
      })
    );

    expect(survey).toEqual({ judged: 1, missing: [], unreadable: 1 });
  });
});
