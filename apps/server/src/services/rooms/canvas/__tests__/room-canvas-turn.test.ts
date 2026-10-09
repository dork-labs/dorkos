/**
 * One room turn, end to end: a `ui_command` off the turn's own stream becomes a
 * row, a frame and one line in the room's log — and never two of any of them
 * (spec `room-canvas` §5.5, §6.2).
 *
 * **The real native Trigger, Runner, dispatcher and projector.** Only the
 * existing TestMode ScenarioFn provider output is scripted; the
 * collector's tap, the per-turn ledger, `finishTurn` in the `finally` — is the
 * code that ships. The room service is real too, over a real SQLite database, so
 * "one row" is read out of the table rather than off a spy.
 *
 * Every case here uses `json` content deliberately. It has no dedupe key, so
 * nothing would quietly absorb a second write: if the tap applied a stamped
 * event as well as the handler, this file would see two rows rather than one
 * refreshed one.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Dropping the `event.applied === undefined` guard on the tap reddens "applies
 *   a stamped event exactly once" with two rows.
 * - Moving `finishTurn` out of the `finally` and into the success path reddens
 *   "a turn the ceiling gave up on still reports what it put on the table".
 * - Composing the coalesced line from the tap's observations rather than the
 *   service's ledger reddens "one line naming both operations".
 *
 * @module server/services/rooms/canvas/tests/room-canvas-turn
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RoomEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

/** Scripted provider output only; original Trigger/native dispatcher are not replaced. */
interface TestProjector {
  ingest: (event: Record<string, unknown>) => { seq: number };
}
type OriginalDispatch = Parameters<
  (typeof import('../../../session/message-dispatcher.js'))['dispatchOriginalRoomMessage']
>[2];
type TriggerCall = Omit<OriginalDispatch, 'projector'> & { projector: TestProjector };
let turnBehaviour: (opts: TriggerCall) => { accepted: boolean; canonicalId?: string };
const triggered: OriginalDispatch[] = [];
vi.mock('../../../session/message-dispatcher.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../session/message-dispatcher.js')>();
  const dispatch = original.dispatchOriginalRoomMessage;
  // Vitest exports are configurable getter-only properties, not writable fields.
  const descriptor = Object.getOwnPropertyDescriptor(original, 'dispatchOriginalRoomMessage');
  if (!descriptor?.configurable || typeof dispatch !== 'function') {
    throw new Error('Original dispatcher export cannot be observed');
  }
  // Preserve the same export object captured during importOriginal's module cycle.
  Object.defineProperty(original, 'dispatchOriginalRoomMessage', {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    value: (
      request: Parameters<typeof dispatch>[0],
      runner: Parameters<typeof dispatch>[1],
      opts: OriginalDispatch
    ) => {
      triggered.push(opts);
      return dispatch(request, runner, opts);
    },
  });
  return original;
});

// Both Node execFile entry points retain the actual subprocess and acquired result.
const measurement = vi.hoisted(() => ({ fail: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const originalPromisifiedExecFile = promisify(original.execFile);
  const unavailable = (args: unknown[]) =>
    measurement.fail && args[0] === 'git' && Array.isArray(args[1]) && args[1].includes('rev-list');
  // Independent callable targets avoid Node's read-only custom-promisifier invariant.
  const execFile = new Proxy(original.execFile.bind(undefined), {
    get(_target, key) {
      const value = Reflect.get(original.execFile, key, original.execFile);
      if (key !== promisify.custom || typeof value !== 'function') return value;
      // Production uses Node's custom promisifier, not the callback entry point.
      return new Proxy(originalPromisifiedExecFile.bind(undefined), {
        apply(_custom, customReceiver, args) {
          const actual = Reflect.apply(originalPromisifiedExecFile, customReceiver, args);
          if (!unavailable(args)) return actual;
          const observed = actual.then(() => {
            throw new Error('Original Git comparison unavailable');
          });
          // Preserve Node's same genuine child handle for any owning observer.
          Object.defineProperty(observed, 'child', { value: actual.child });
          return observed;
        },
      });
    },
    apply(_target, receiver, args) {
      const callback = args.at(-1);
      if (unavailable(args) && typeof callback === 'function') {
        return Reflect.apply(original.execFile, receiver, [
          ...args.slice(0, -1),
          (cause: unknown, stdout: unknown, stderr: unknown) =>
            callback(cause ?? new Error('Original Git comparison unavailable'), stdout, stderr),
        ]);
      }
      return Reflect.apply(original.execFile, receiver, args);
    },
  });
  return { ...original, execFile };
});

const { createOriginalNativeLaunchFixture } =
  await import('../../repo/__tests__/room-original-native-launch-fixture.js');
const { scenarioStore } = await import('../../../runtimes/test-mode/scenario-store.js');
const { readTestModeOriginalActiveStream } =
  await import('../../../runtimes/test-mode/test-mode-runtime.js');
const { runtimeRegistry } = await import('../../../core/runtime-registry.js');
const { isTurnInFlight } = await import('../../../session/message-dispatcher.js');
const { peekProjector } = await import('../../../session/index.js');
const { fixtureGit } = await import('../../repo/__tests__/fixture-git.js');
const { uiTurnFacts } = await import('../../../session/browser-seat/ui-turn-facts.js');
type OriginalFixture = Awaited<ReturnType<typeof createOriginalNativeLaunchFixture>>;
let original: OriginalFixture | undefined;
let target: Awaited<ReturnType<OriginalFixture['bootNativeAgent']>> | undefined;
let currentEntry: string | undefined;
let baselineSeq = 0;
let ANA = '';
let nativeCopyPath: string | undefined;

async function closeNative(): Promise<void> {
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    await original?.close();
    original = undefined;
    target = undefined;
    currentEntry = undefined;
    nativeCopyPath = undefined;
  } catch (cause) {
    remember(cause);
  }
  try {
    vi.restoreAllMocks();
  } catch (cause) {
    remember(cause);
  }
  if (failed) throw first;
}

async function openNative(seed = false): Promise<void> {
  await closeNative();
  measurement.fail = false;
  triggered.length = 0;
  baselineSeq = 0;
  original = await createOriginalNativeLaunchFixture({ seed });
  target = await original.bootNativeAgent();
  ANA = target.agentPath;
  const actualScenario = scenarioStore.getScenario.bind(scenarioStore);
  vi.spyOn(scenarioStore, 'getScenario').mockImplementation((sessionId) => {
    if (sessionId !== target?.sessionId) return actualScenario(sessionId);
    return async function* (_content, context, opts) {
      if (!original || !target || context.sessionId !== target.sessionId || !currentEntry) {
        throw new Error('Original Canvas provider target is absent');
      }
      const runtime = runtimeRegistry.get('claude-code');
      const prepared = original.readPreparedContext(target.sessionId);
      const dispatch = triggered.at(-1);
      if (
        !readTestModeOriginalActiveStream(runtime, target.sessionId) ||
        prepared?.room.id !== original.roomId ||
        prepared.triggerEntryId !== currentEntry ||
        dispatch?.sessionId !== target.sessionId ||
        opts?.roomTurn?.turnId !== dispatch.roomTurn?.turnId ||
        uiTurnFacts.read(target.sessionId).roomTurn?.roomId !== original.roomId
      ) {
        throw new Error('Original current native Canvas stream is unavailable');
      }
      // This buffer scripts provider output; it never ingests a projector event.
      const output: Record<string, unknown>[] = [];
      const scripted: TriggerCall = {
        ...dispatch,
        projector: {
          ingest: (event) => {
            output.push(event);
            return { seq: output.length };
          },
        },
        onTurnStart: () => undefined,
      };
      const result = turnBehaviour(scripted);
      if (!result.accepted)
        throw new Error('Canvas provider script did not accept its actual turn');
      yield {
        type: 'session_status',
        data: { sessionId: target.sessionId, model: 'test-mode' },
      } as StreamEvent;
      for (const event of output) {
        if (event.type === 'turn_start') continue; // The real dispatcher already opened this turn.
        if (event.type === 'turn_end') {
          yield { type: 'done', data: { sessionId: target.sessionId } } as StreamEvent;
        } else if (event.type === 'text_delta') {
          yield { type: 'text_delta', data: { text: event.text } } as StreamEvent;
        } else if (event.type === 'ui_command') {
          yield {
            type: 'ui_command',
            data: {
              command: event.command,
              ...(event.applied !== undefined ? { applied: event.applied } : {}),
            },
          } as StreamEvent;
        } else throw new Error('Unexpected Canvas provider output');
      }
    };
  });
  turnBehaviour = (opts) => {
    openTurn(opts);
    opts.projector.ingest({ type: 'turn_end' });
    return { accepted: true, canonicalId: opts.sessionId };
  };
  if (seed) {
    // Native authenticated enable pins ROOM.md; retire only that setup document.
    for (const document of original.subsystem.service.canvas.list(original.roomId))
      original.subsystem.service.canvas.close(original.roomId, original.operator.id, document.id);
    await runNative();
    const prepared = original.readPreparedContext(target.sessionId);
    if (!prepared?.files) throw new Error('Original native Room copy was not prepared');
    nativeCopyPath = prepared.files.worktreePath;
  }
  baselineSeq =
    original.subsystem.service
      .listEntries(original.roomId, original.operator.id, { limit: 100 })
      .at(-1)?.seq ?? 0;
  triggered.length = 0;
}

async function nativeCopy(): Promise<string> {
  if (!nativeCopyPath) throw new Error('Original native copy is absent');
  return nativeCopyPath;
}

/** Scenario input DATA never becomes an original Room request or folder grant. */
function turnRequest(files?: {
  worktreePath: string;
  branch: string;
  repoPath: string;
  ahead: number | null;
  behind: number | null;
}) {
  return files;
}

async function runNative(files?: ReturnType<typeof turnRequest>): Promise<unknown> {
  if (!original || !target) throw new Error('Original native Canvas fixture is absent');
  const sessionId = target.sessionId;
  if (files) {
    const copy = await nativeCopy();
    if (fs.realpathSync(files.worktreePath) !== fs.realpathSync(copy))
      throw new Error('Canvas scenario does not name the original native working copy');
    // Actual commits, rather than a copied ahead count, establish the review state.
    for (let n = 0; n < (files.ahead ?? 0); n++) {
      fs.writeFileSync(path.join(copy, `native-ahead-${n}.txt`), String(n));
      await fixtureGit(['add', '--all'], copy, original.repos.homeDir(original.roomId));
      await fixtureGit(
        [
          '-c',
          'user.name=Original Native Agent',
          '-c',
          'user.email=native@fixture.test',
          'commit',
          '--no-verify',
          '-m',
          `native review ${n}`,
        ],
        copy,
        original.repos.homeDir(original.roomId)
      );
    }
  }
  const entry = original.subsystem.service.post(original.roomId, {
    authorId: original.operator.id,
    text: 'show me the plan',
    mentions: [target.authorId],
  });
  currentEntry = entry.id;
  await original.subsystem.service.triggersIdle();
  // Native stream retirement precedes final sender/projector retirement.
  // A successor uses the same real session only after both owners are idle.
  await vi.waitFor(() => {
    const selected = runtimeRegistry.get('claude-code');
    expect(isTurnInFlight(sessionId, selected)).toBe(false);
    expect(peekProjector(sessionId)?.getStatus().lifecycle).toBe('idle');
  });
  return entry;
}

/** Provider script delimiter only; the actual dispatcher owns turn_start and its cursor. */
function openTurn(opts: TriggerCall): void {
  const start = opts.projector.ingest({ type: 'turn_start' });
  opts.onTurnStart?.(start.seq);
}

const { tooManyCanvasOpsMessage } = await import('../room-canvas-service.js');

type Harness = {
  service: OriginalFixture['subsystem']['service'];
  authors: OriginalFixture['subsystem']['authors'];
  human: string;
};

/** A json document — no dedupe key, so a double write shows up as a second row. */
const jsonCommand = (label: string) => ({
  action: 'open_canvas' as const,
  content: { type: 'json' as const, data: { label }, title: label },
});

describe('a room turn’s canvas commands', () => {
  let harness: Harness;
  let room: RoomWithRoster;
  let ana: string;

  beforeEach(async () => {
    await openNative();
    if (!original || !target) throw new Error('Original native Canvas fixture is absent');
    harness = {
      service: original.subsystem.service,
      authors: original.subsystem.authors,
      human: original.operator.id,
    };
    const currentRoom = harness.service.getRoom(original.roomId, harness.human);
    if (!currentRoom) throw new Error('Original authenticated Canvas Room is absent');
    room = currentRoom;
    ana = target.authorId;
  });
  afterEach(closeNative);

  /** Case operations only, excluding genuine native installation/copy setup. */
  const log = () =>
    harness.service
      .listEntries(room.id, harness.human, { limit: 100 })
      .filter((entry) => entry.seq > baselineSeq);

  it('carries the room, the member and one turn id into the runtime', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());

    // Routing metadata, and every field of it server-derived. Without this a
    // `control_ui` the turn takes has no way to know which room it is in.
    expect(triggered[0].roomTurn).toMatchObject({ roomId: room.id, authorId: ana });
    expect(typeof triggered[0].roomTurn?.turnId).toBe('string');
  });

  it('applies an UNSTAMPED command — the codex and test-mode path', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());

    const documents = harness.service.canvas.list(room.id);
    expect(documents).toHaveLength(1);
    expect(documents[0].title).toBe('the plan');
    expect(documents[0].authorId).toBe(ana);
  });

  it('applies a STAMPED command exactly once — the handler already did', async () => {
    // The dedupe, and the whole reason the stamp exists. `json` has no source
    // key, so a tap that ignored the stamp would leave TWO rows here rather than
    // one refreshed one — which is what makes this able to fail.
    const applied = harness.service.canvas.apply({
      roomId: room.id,
      authorId: ana,
      turnId: 'handler-turn',
      command: jsonCommand('the plan'),
    });
    expect(applied.applied).toBe(true);

    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({
        type: 'ui_command',
        command: jsonCommand('the plan'),
        applied: applied.applied ? { documentId: applied.documentId, rev: applied.rev } : undefined,
      });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());

    expect(harness.service.canvas.list(room.id)).toHaveLength(1);
  });

  it('writes exactly one line in the room’s log, naming every operation', async () => {
    const before = log().length;
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
      opts.projector.ingest({
        type: 'ui_command',
        command: { action: 'browser_navigate', url: 'http://localhost:5173/' },
      });
      opts.projector.ingest({ type: 'text_delta', text: 'Put it on the canvas.' });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());

    const entries = log();
    const canvasLines = entries.filter((entry) => entry.body.canvas !== undefined);
    expect(canvasLines).toHaveLength(1);
    expect(canvasLines[0].body.canvas?.ops).toHaveLength(2);
    expect(canvasLines[0].body.subjectAuthorId).toBe(ana);
    // It wakes nobody: written by the system author, addressing no one.
    expect(canvasLines[0].authorId).toBe(harness.authors.system().id);
    expect(canvasLines[0].mentions).toEqual([]);
    expect(entries.length).toBeGreaterThan(before);
  });

  describe('a room that has files of its own', () => {
    beforeEach(async () => {
      await openNative(true);
      if (!original || !target) throw new Error('Original native Canvas fixture is absent');
      harness = {
        service: original.subsystem.service,
        authors: original.subsystem.authors,
        human: original.operator.id,
      };
      const currentRoom = harness.service.getRoom(original.roomId, harness.human);
      if (!currentRoom) throw new Error('Original authenticated Canvas Room is absent');
      room = currentRoom;
      ana = target.authorId;
    });

    it('records how far ahead of the room the turn’s copy was', async () => {
      // **The tap's own carry, not the handler's.** A claude-code turn goes
      // through `control_ui`, which has always passed this; every OTHER runtime —
      // codex, opencode, the scripted one — reaches the table through this tap,
      // and without the carry each of their documents records "not measured".
      // The review surface (spec `canvas-agent-seat` §8) appears only for a copy
      // that is measurably ahead, so the whole of it was unreachable from three
      // of the four runtimes.
      // The turn stands at home and names the file by its full path in its
      // copy (spec `agent-home-desk` §5.6): the source path decides the tree.
      const copy = await nativeCopy();
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({
          type: 'ui_command',
          command: { action: 'open_diff', sourcePath: `${copy}/app.txt` },
        });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      await runNative(
        turnRequest({
          worktreePath: copy,
          branch: 'room/ana',
          repoPath: original!.repos.repoPath(room.id),
          ahead: 3,
          behind: 0,
        })
      );

      const [document] = harness.service.canvas.list(room.id);
      expect(document?.treeKind).toBe('worktree');
      expect(document?.aheadOfMain).toBe(3);
      // Stored relative to that copy, as the review and the merge read it — an
      // absolute path is refused there. Seeded: storing the path as sent
      // reddens this.
      expect((document?.content as { sourcePath?: string }).sourcePath).toBe('app.txt');
    });

    it('labels the copy whichever spelling of it the turn and the file use', async () => {
      // The turn's grants name the copy by its REAL path (`/private/tmp/…` on
      // macOS, a symlinked home anywhere) while the file command may hold another
      // spelling. One folder, one tree. Seeded: comparing the raw strings
      // reddens this (the document falls to "in Ana's project" and the review
      // surface never appears).
      const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-spell-')));
      try {
        const realCopy = await nativeCopy();
        fs.symlinkSync(realCopy, path.join(scratch, 'link'));
        const linkedCopy = path.join(scratch, 'link');
        turnBehaviour = (opts) => {
          openTurn(opts);
          opts.projector.ingest({
            type: 'ui_command',
            command: { action: 'open_diff', sourcePath: path.join(linkedCopy, 'app.txt') },
          });
          opts.projector.ingest({ type: 'turn_end' });
          return { accepted: true, canonicalId: opts.sessionId };
        };
        await runNative(
          turnRequest({
            worktreePath: linkedCopy,
            branch: 'room/ana',
            repoPath: original!.repos.repoPath(room.id),
            ahead: 1,
            behind: 0,
          })
        );

        const [document] = harness.service.canvas.list(room.id);
        expect(document?.treeKind).toBe('worktree');
        expect(document?.aheadOfMain).toBe(1);
        expect((document?.content as { sourcePath?: string }).sourcePath).toBe('app.txt');
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });

    it('stores a file whose name starts with two dots relative to the copy too', async () => {
      // `..notes.md` is a file INSIDE the copy; only a first segment of exactly
      // `..` leaves it. Seeded: rejecting any relative path starting with `..`
      // stores it absolute, which the review refuses.
      const copy = await nativeCopy();
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({
          type: 'ui_command',
          command: { action: 'open_diff', sourcePath: `${copy}/..notes.md` },
        });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      await runNative(
        turnRequest({
          worktreePath: copy,
          branch: 'room/ana',
          repoPath: original!.repos.repoPath(room.id),
          ahead: 1,
          behind: 0,
        })
      );

      const [document] = harness.service.canvas.list(room.id);
      expect(document?.treeKind).toBe('worktree');
      expect((document?.content as { sourcePath?: string }).sourcePath).toBe('..notes.md');
    });

    it('records “not measured” when the dispatcher measured nothing', async () => {
      measurement.fail = true;
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({
          type: 'ui_command',
          command: { action: 'open_diff', sourcePath: 'app.txt' },
        });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      await runNative(turnRequest());

      const [document] = harness.service.canvas.list(room.id);
      // `null`, never `0`: nobody asked, which is a different claim from "level
      // with the room" and must not be shown as one.
      expect(document?.aheadOfMain).toBeNull();
    });
  });

  describe('the face the turn leaves behind', () => {
    /** Start listening to the room's stream; answer with its presence frames. */
    function watchPresence() {
      const abort = new AbortController();
      const seen: RoomEvent[] = [];
      const reading = (async () => {
        for await (const event of harness.service.stream.subscribe(room.id, abort.signal)) {
          seen.push(event);
        }
      })();
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        abort.abort();
        await reading;
        return seen.filter((e) => e.type === 'signal' && e.signal === 'presence');
      };
    }

    it('takes it off at the end, whatever the turn did', async () => {
      // The agent looked at something mid-turn, as `read_canvas` records it.
      const document = harness.service.canvas.open(room.id, ana, {
        type: 'json',
        data: {},
        title: 'the plan',
      });
      harness.service.canvas.noteAgentRead(room.id, ana, document.id);

      const frames = watchPresence();
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      await runNative(turnRequest());

      const released = await frames();
      expect(released).toMatchObject([{ authorId: ana }]);
      expect(released[0]).not.toHaveProperty('documentId');
    });

    it('takes it off even when posting the turn’s line throws', async () => {
      // **Why the two are in separate `try` blocks.** Posting can fail — a room
      // archived mid-turn, a busy database — and a shared `try` would mean the
      // very endings that go wrong are the ones that leave an agent's face on a
      // tab for a turn that has stopped.
      const document = harness.service.canvas.open(room.id, ana, {
        type: 'json',
        data: {},
        title: 'the plan',
      });
      harness.service.canvas.noteAgentRead(room.id, ana, document.id);
      vi.spyOn(harness.service.canvas, 'finishTurn').mockImplementation(() => {
        throw new Error('the database is locked');
      });

      const frames = watchPresence();
      turnBehaviour = (opts) => {
        openTurn(opts);
        opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
        opts.projector.ingest({ type: 'turn_end' });
        return { accepted: true, canonicalId: opts.sessionId };
      };
      // And the failure stays inside: `collectReply`'s `closed` promise is
      // documented as never rejecting.
      await expect(runNative(turnRequest())).resolves.toBeDefined();

      const released = await frames();
      expect(released).toMatchObject([{ authorId: ana }]);
    });
  });

  it('triggers no turn for anybody', async () => {
    // The property ADR 260911-200302 exists for, read off the dispatcher rather
    // than off a sleep: the canvas line is an entry, and an entry is the one
    // thing that starts a turn in a room — so an entry that started one would
    // show up here as a second dispatch.
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('the plan') });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());
    await harness.service.triggersIdle();

    expect(triggered).toHaveLength(1);
  });

  it('records the tree a FILE document was opened against', async () => {
    // Without the turn's cwd on the collector's bounds, every document the tap
    // writes records nothing — and the §8.1 reader rule short-circuits to
    // "anybody may read this", which is the rule inverted rather than relaxed.
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({
        type: 'ui_command',
        command: { action: 'open_file', sourcePath: 'src/router.ts' },
      });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());

    const [document] = harness.service.canvas.list(room.id);
    expect(document.treeKind).toBe('agent-cwd');
    expect(harness.service.canvas.resolvedTreeOf(room.id, document.id)).toBe(ANA);
    // …and a member standing somewhere else is refused its contents, which is
    // the behaviour the recorded tree is FOR.
    expect(harness.service.canvas.mayReadContent(document, '/somewhere/else')).toBe(false);
    expect(harness.service.canvas.mayReadContent(document, ANA)).toBe(true);
  });

  it('names an operation that lands AFTER its turn closed, exactly once', async () => {
    // The ceiling can give up on a turn the agent is still running, and the spec
    // allows that agent to carry on. An operation from it used to open a fresh
    // ledger nothing would ever close: a row on the table with no line in the
    // log naming it, and a map that grew for the life of the process.
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'ui_command', command: jsonCommand('during') });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());
    const turnId = triggered[0].roomTurn?.turnId ?? '';
    expect(turnId).not.toBe('');

    // The straggler: same turn id, long after the collector settled.
    const late = harness.service.canvas.apply({
      roomId: room.id,
      authorId: ana,
      turnId,
      command: jsonCommand('after the ceiling gave up'),
    });
    expect(late.applied).toBe(true);

    const canvasLines = log().filter((entry) => entry.body.canvas !== undefined);
    // Two lines, not one and not three: the turn's own, and the straggler's.
    // Every applied operation is named exactly once.
    expect(canvasLines).toHaveLength(2);
    expect(canvasLines[0].body.canvas?.ops.map((op) => op.title)).toEqual(['during']);
    expect(canvasLines[1].body.canvas?.ops.map((op) => op.title)).toEqual([
      'after the ceiling gave up',
    ]);
    // And it left nothing behind: the ledger it would once have opened is not
    // there, because it was never filed.
    expect(harness.service.canvas.bookkeepingSize().openLedgers).toBe(0);
  });

  it('keeps its memory of FINISHED turns bounded however many turns run', async () => {
    // `finishTurn` remembers a turn so a straggler is recognised and charged,
    // and that memory has to stop growing. Driven past the count bound rather
    // than reasoned about.
    const canvas = harness.service.canvas;
    for (let n = 0; n < 700; n += 1) canvas.finishTurn(`turn-${n}`);
    const { openLedgers, rememberedTurns } = canvas.bookkeepingSize();
    expect(openLedgers).toBe(0);
    expect(rememberedTurns).toBeLessThanOrEqual(500);
  });

  it('keeps its OPEN ledgers bounded however many turns never close', async () => {
    // The other map, and it needs its own case: the two bounds are separate
    // constants precisely so a break in one cannot hide behind the other. A
    // ledger is opened by the first operation of a turn and emptied by
    // `finishTurn`; a turn whose process died never reaches one, so without a
    // count bound this map grows for the life of the server.
    const canvas = harness.service.canvas;
    for (let n = 0; n < 700; n += 1) {
      canvas.apply({
        roomId: room.id,
        authorId: ana,
        turnId: `abandoned-${n}`,
        command: jsonCommand(`doc ${n}`),
      });
    }
    const { openLedgers, rememberedTurns } = canvas.bookkeepingSize();
    expect(openLedgers).toBeLessThanOrEqual(500);
    // …and none of them was closed, so nothing leaked into the other map.
    expect(rememberedTurns).toBe(0);
  });

  it('writes no line at all for a turn that changed nothing', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      opts.projector.ingest({ type: 'text_delta', text: 'Nothing to show.' });
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());

    expect(log().filter((entry) => entry.body.canvas !== undefined)).toEqual([]);
  });

  it('refuses past the ceiling and names only what it applied', async () => {
    turnBehaviour = (opts) => {
      openTurn(opts);
      for (const n of [1, 2, 3, 4]) {
        opts.projector.ingest({ type: 'ui_command', command: jsonCommand(`doc ${n}`) });
      }
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());

    // Three rows, and a line naming three. An operation nothing applied is
    // claimed nowhere — which is the honest guarantee on this path, where a
    // refusal cannot reach the model.
    expect(harness.service.canvas.list(room.id)).toHaveLength(3);
    const canvasLines = log().filter((entry) => entry.body.canvas !== undefined);
    expect(canvasLines).toHaveLength(1);
    expect(canvasLines[0].body.canvas?.ops).toHaveLength(3);
    // And the sentence a refused operation would have carried is the one the
    // handler path returns, not something this path invents.
    expect(tooManyCanvasOpsMessage(3)).toContain('3 times');
  });

  it('does not hand a finished turn a fresh ceiling', async () => {
    // The ceiling is a per-TURN budget, and ending is not how a turn earns a new
    // one. Counting only the OPEN ledger reads zero for every turn that has
    // closed, so an agent still running past its own line could spend three,
    // three, three, forever — measured, before this stood, as eight more
    // applied operations and nine canvas lines for one turn.
    turnBehaviour = (opts) => {
      openTurn(opts);
      for (const n of [1, 2, 3, 4]) {
        opts.projector.ingest({ type: 'ui_command', command: jsonCommand(`doc ${n}`) });
      }
      opts.projector.ingest({ type: 'turn_end' });
      return { accepted: true, canonicalId: opts.sessionId };
    };
    await runNative(turnRequest());
    const turnId = triggered[0].roomTurn?.turnId ?? '';
    expect(turnId).not.toBe('');

    const late = harness.service.canvas.apply({
      roomId: room.id,
      authorId: ana,
      turnId,
      command: jsonCommand('one more, after the line went out'),
    });

    // Refused exactly as the in-turn fourth was, with the same sentence.
    expect(late).toMatchObject({ applied: false, code: 'TOO_MANY_CANVAS_OPS_THIS_TURN' });
    // And a refusal writes nothing: no row, and no line announcing one.
    expect(harness.service.canvas.list(room.id)).toHaveLength(3);
    expect(log().filter((entry) => entry.body.canvas !== undefined)).toHaveLength(1);
  });
});
