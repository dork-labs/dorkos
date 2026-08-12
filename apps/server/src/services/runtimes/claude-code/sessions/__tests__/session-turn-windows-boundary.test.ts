/**
 * The directory boundary on the DISPATCH path (spec
 * `persistent-session-runtime` §Security, task 3.9).
 *
 * Every case drives the REAL validator against REAL directories — a temporary
 * boundary root, a dork-home deliberately outside it (exactly the shape a
 * boundary-scoped deployment has), and a real symlink planted inside the
 * carve-out. Nothing here mocks `lib/boundary.js`, because several of the
 * things being proved are which paths that module lets through: a mocked
 * validator would answer whatever the test told it to and certify nothing.
 *
 * The three mutations these cases were checked against, all reproduced:
 * deleting the dispatch gate turns every case red but the agents-subtree one;
 * swapping the gate to the plain `validateBoundary` turns EXACTLY the
 * agents-subtree case red; moving the gate below the `closingWindows` wait
 * times out the ordering case.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-windows-boundary
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BoundaryError, initBoundary } from '../../../../../lib/boundary.js';
import type { PumpDispatch } from '../session-pump-contract.js';
import { SessionPump } from '../session-pump.js';
import { SessionTurnWindows, type TurnWindow } from '../session-turn-windows.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';

const SESSION_ID = 'sess-boundary';

/** A directory inside the operator's boundary — the ordinary project case. */
let INSIDE: string;
/** A directory outside every allowed root. */
let OUTSIDE: string;
/** DorkBot's own home, under `{dorkHome}/agents/` and outside the boundary. */
let AGENT_HOME: string;
/** The encrypted credential store: a dork-home sibling of `agents/`. */
let SECRETS: string;
/** The credential store reached by a `..` spelled INSIDE the agents subtree. */
let TRAVERSAL: string;
/** A SYMLINK living inside `agents/` whose target is the credential store. */
let SYMLINK_ESCAPE: string;

let tmpRoot: string;
const originalDorkHome = process.env.DORK_HOME;

beforeAll(async () => {
  // realpath'd up front: macOS hands out `/var/...` temp dirs that resolve to
  // `/private/var/...`, and a containment check compares resolved paths.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor1174-')));
  const boundaryRoot = path.join(tmpRoot, 'workspace');
  // Outside the boundary on purpose — the Docker shape the carve-out exists for.
  const dorkHome = path.join(tmpRoot, 'dork-home');
  INSIDE = path.join(boundaryRoot, 'project');
  OUTSIDE = path.join(tmpRoot, 'elsewhere');
  AGENT_HOME = path.join(dorkHome, 'agents', 'dorkbot');
  SECRETS = path.join(dorkHome, 'extension-secrets');
  for (const dir of [INSIDE, OUTSIDE, AGENT_HOME, SECRETS]) {
    await fs.mkdir(dir, { recursive: true });
  }
  // Two ways of spelling the credential store that LOOK like the carve-out.
  TRAVERSAL = path.join(dorkHome, 'agents', '..', 'extension-secrets');
  SYMLINK_ESCAPE = path.join(dorkHome, 'agents', 'escape');
  await fs.symlink(SECRETS, SYMLINK_ESCAPE);
  process.env.DORK_HOME = dorkHome;
  await initBoundary(boundaryRoot);
});

afterAll(async () => {
  if (originalDorkHome === undefined) delete process.env.DORK_HOME;
  else process.env.DORK_HOME = originalDorkHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A windower over a pump that records what it was asked to send. */
function recordingHarness(): {
  windows: SessionTurnWindows;
  sent: PumpDispatch[][];
  opened: TurnWindow[];
} {
  const sent: PumpDispatch[][] = [];
  const opened: TurnWindow[] = [];
  const windows = new SessionTurnWindows({
    sessionId: SESSION_ID,
    pump: {
      dispatch: (batch) => {
        sent.push([...batch]);
        return Promise.resolve();
      },
      endTurn: () => {},
      controlQuery: undefined,
    },
    onWindowOpen: (window) => opened.push(window),
  });
  return { windows, sent, opened };
}

/** A `result` answering `answers`, enough to close a window. */
function resultMessage(answers: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    uuid: `result-${answers}`,
    session_id: 'sdk-1',
    user_message_uuid: answers,
  } as unknown as SDKMessage;
}

interface RealHarness {
  pump: SessionPump;
  windows: SessionTurnWindows;
  queries: FakeQuery[];
  opened: TurnWindow[];
  live: () => FakeQuery;
}

/**
 * A windower over a REAL pump and a scripted subprocess.
 *
 * @param usageTimeoutMs - How long a close may wait for its accounting. The
 *   default is short so ordinary cases settle; the ordering case raises it far
 *   above its own test timeout, because a close that can rescue itself by
 *   timing out cannot prove anything about what the dispatch waited for.
 */
function realHarness(usageTimeoutMs = 500): RealHarness {
  const queries: FakeQuery[] = [];
  const opened: TurnWindow[] = [];
  const ref: { windows?: SessionTurnWindows } = {};
  const pump = new SessionPump({
    sessionId: SESSION_ID,
    launch: () => {
      const query = new FakeQuery();
      queries.push(query);
      return query;
    },
    onMessage: (message) => ref.windows?.onMessage(message),
    onCrash: (crash) => ref.windows?.onCrash(crash),
    drainGraceMs: 20,
  });
  const windows = new SessionTurnWindows({
    sessionId: SESSION_ID,
    pump,
    usageTimeoutMs,
    onWindowOpen: (window) => opened.push(window),
  });
  ref.windows = windows;
  return { pump, windows, queries, opened, live: () => queries[queries.length - 1]! };
}

/**
 * Take one in-boundary turn on a real process and leave the session WARM — the
 * state the whole task is about, where a launch check would already be spent.
 */
async function warmed(): Promise<RealHarness> {
  const h = realHarness();
  const dispatching = h.windows.dispatch([{ content: 'hello', messageId: 'm1' }], INSIDE);
  await vi.waitFor(() => expect(h.queries.length).toBe(1));
  h.live().emit(initMessage());
  await dispatching;
  h.live().emit(resultMessage('m1'));
  await vi.waitFor(() => expect(h.pump.state).toBe('warm'));
  return h;
}

describe('SessionTurnWindows — the boundary is asked per dispatch', () => {
  // AC1. The gate itself: a turn asking to run outside the boundary is refused
  // with the boundary's own typed error, and nothing about it happens.
  it('refuses an out-of-boundary cwd and opens no window', async () => {
    const h = recordingHarness();

    await expect(
      h.windows.dispatch([{ content: 'do the thing', messageId: 'm1' }], OUTSIDE)
    ).rejects.toBeInstanceOf(BoundaryError);

    // Nothing was sent, so nothing can have reached the model...
    expect(h.sent).toHaveLength(0);
    // ...and nobody was told a turn started, which is what retires the queue
    // row: a message refused here is still in the queue, still the person's.
    expect(h.opened).toHaveLength(0);
    expect(h.windows.openWindow).toBeUndefined();
  });

  // AC2. The reason this task exists. The process is already up and already
  // past its launch-time check, so only a per-dispatch gate can catch this.
  it('refuses the second dispatch when the cwd moves out of bounds mid-session', async () => {
    const h = await warmed();
    expect(h.opened).toHaveLength(1);

    await expect(
      h.windows.dispatch([{ content: 'now escape', messageId: 'm2' }], OUTSIDE)
    ).rejects.toBeInstanceOf(BoundaryError);

    expect(h.opened).toHaveLength(1);
    expect(h.windows.openWindow).toBeUndefined();
  });

  // AC3. The carve-out the turn path has always had: DorkBot and every
  // marketplace agent live under `{dorkHome}/agents/`, outside a narrow
  // boundary, and their turns are legitimate work. Reaching for the plain
  // `validateBoundary` here would 403 the system agent, which is this case.
  it('lets an agent take a turn in its own home under the agents subtree', async () => {
    const h = recordingHarness();

    const window = await h.windows.dispatch(
      [{ content: 'apply your persona', messageId: 'm1' }],
      AGENT_HOME
    );

    expect(window.ids).toEqual(['m1']);
    expect(h.sent).toEqual([[{ content: 'apply your persona', messageId: 'm1' }]]);
    expect(h.opened).toHaveLength(1);
  });

  // AC4. The other half of the carve-out: it is the agents SUBTREE, never all
  // of dork-home. The credential store is a sibling of `agents/`, and a turn
  // must not be able to run in it.
  it('still refuses a dork-home sibling such as the credential store', async () => {
    const h = recordingHarness();

    await expect(
      h.windows.dispatch([{ content: 'read the secrets', messageId: 'm1' }], SECRETS)
    ).rejects.toBeInstanceOf(BoundaryError);

    expect(h.sent).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  // AC5. A refusal is not a failure of the session. The process it was about to
  // ride is untouched, and the next legitimate message runs on that same
  // process — no reap, no crash, no relaunch.
  it('leaves the warm session usable for the next in-boundary message', async () => {
    const h = await warmed();
    await expect(
      h.windows.dispatch([{ content: 'now escape', messageId: 'm2' }], OUTSIDE)
    ).rejects.toBeInstanceOf(BoundaryError);

    expect(h.pump.state).toBe('warm');
    expect(h.live().closed).toBe(0);

    const window = await h.windows.dispatch([{ content: 'carry on', messageId: 'm3' }], INSIDE);
    expect(window.ids).toEqual(['m3']);
    expect(h.pump.state).toBe('running');
    // The SAME process, still: the refusal cost the session nothing.
    expect(h.queries).toHaveLength(1);

    h.live().emit(resultMessage('m3'));
    await vi.waitFor(() => expect(h.pump.state).toBe('warm'));
    expect(h.opened).toHaveLength(2);
  });

  // AC6. The carve-out is a containment check on the RESOLVED path, never a
  // check on how the path was spelled. A `..` that starts inside `agents/` and
  // lands on the credential store is the credential store.
  it('refuses a traversal spelled inside the agents subtree', async () => {
    const h = recordingHarness();

    await expect(
      h.windows.dispatch([{ content: 'read the secrets', messageId: 'm1' }], TRAVERSAL)
    ).rejects.toBeInstanceOf(BoundaryError);

    expect(h.sent).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  // AC7. The same question asked the way an attacker would actually ask it: a
  // symlink that LIVES in the carve-out and POINTS at the credential store.
  // Validation resolves symlinks (`fs.realpath`) rather than trusting the
  // spelling, so the carve-out cannot be escaped by planting one — and if that
  // resolution is ever dropped as an optimization, this goes red.
  it('refuses a symlink inside the agents subtree that targets the credential store', async () => {
    const h = recordingHarness();

    await expect(
      h.windows.dispatch([{ content: 'follow the link', messageId: 'm1' }], SYMLINK_ESCAPE)
    ).rejects.toBeInstanceOf(BoundaryError);

    expect(h.sent).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  // AC8. The gate is asked AHEAD of the wait for closing windows, not after it.
  // A turn that may not run has no business being held for the length of
  // another window's accounting fetch.
  //
  // The accounting here is parked and never released, and the window's own
  // timeout is set far beyond this test's, so a gate moved below the
  // `closingWindows` wait cannot settle at all: the case times out instead of
  // merely being slower. That is what makes it discriminate — verified by
  // moving the gate and watching this time out at 3s.
  it('refuses without waiting for a close that is still in flight', async () => {
    const h = realHarness(60_000);
    const dispatching = h.windows.dispatch([{ content: 'hello', messageId: 'm1' }], INSIDE);
    await vi.waitFor(() => expect(h.queries.length).toBe(1));
    h.live().emit(initMessage());
    await dispatching;

    h.live().holdControls = true;
    h.live().emit(resultMessage('m1'));
    await vi.waitFor(() => expect(h.live().parkedControls).toBeGreaterThan(0));

    await expect(
      h.windows.dispatch([{ content: 'now escape', messageId: 'm2' }], OUTSIDE)
    ).rejects.toBeInstanceOf(BoundaryError);

    // The close really was still in flight for the whole refusal.
    expect(h.live().parkedControls).toBeGreaterThan(0);
    h.live().releaseControls();
  }, 3000);
});
