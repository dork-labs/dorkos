/**
 * The wire conformance suite (spec `space-computer-contract` §12, step W3).
 *
 * Every case runs twice (invariant N1): once **in process**, with the home's
 * link and the computer's link joined by a plain queue and no channel, and
 * once **over the wire**, with the real dialer, the real hub connection and the
 * real channel cryptography over the in-memory socket pair. A case passes only
 * when both runs pass, and each run must really start its ends
 * ({@link runWireCase}).
 *
 * This package never imports the server (the server depends on it), so the
 * server hands its real pieces in ({@link WireParts}), the way
 * `runtimeConformance` takes a runtime factory.
 *
 * **Adding a case.** A step writes its cases in `wire-cases/<step>.ts` as
 * {@link WireCase}s, written once against {@link WireRunner}, and adds them to
 * {@link WIRE_CASES}. Nothing else changes: the server's one call to
 * {@link wireConformance} runs them both ways.
 *
 * @module test-utils/wire-conformance
 */
import { describe, it } from 'vitest';
import type { RelayCall, RelayCallFeature } from '@dorkos/shared/session-relay-agent-computer';
import type { RelayError } from '@dorkos/shared/session-relay';
import { Wire, type WireSocket } from './relay-socket-pair.js';
import { fakeComputer, fakeHome, type FakeComputer, type FakeHome } from './wire-fakes.js';
import { HELLO_CASES } from './wire-cases/hello.js';

export { fakeComputer, fakeHome, type FakeComputer, type FakeHome } from './wire-fakes.js';

/** A call's outcome as the computer sees it: the answer body, or why there is none. */
export type WireCallOutcome = { ok: true; body: unknown } | { ok: false; error: RelayError };

/** One opened inner frame, as a raw end reads it. */
export interface WireInnerFrame {
  type: string;
  id?: unknown;
  ok?: unknown;
  body?: unknown;
  error?: unknown;
}

/** What both ends are started with. */
export interface WireStart {
  /** What the computer names in its `hello`. */
  computer: readonly string[];
  /** The calls the home serves. */
  home: readonly RelayCallFeature[];
  /** Calls the home takes and never answers, so a drop can land mid-call. */
  hold?: readonly RelayCallFeature[];
}

/** The home's end, as a case reads it. */
export interface WireHomeView {
  /** The agent-computer features this home agreed to. */
  agreed(): readonly string[];
  /** Whether the connection is up on the home's side. */
  connected(): boolean;
  /** Every call the home served. */
  readonly served: readonly RelayCall[];
}

/** Both ends of one connection. */
export interface WireEnds {
  /** The home's end. */
  readonly home: WireHomeView;
  /** The computer's end. */
  readonly computer: {
    /** The agent-computer features this computer agreed to. */
    agreed(): readonly string[];
    /** Whether the connection is up on the computer's side. */
    connected(): boolean;
    /** Make one call through the computer's own check; settle to deliver it. */
    call(call: RelayCall): Promise<WireCallOutcome>;
    /** How many frames the computer has sent so far. */
    sent(): number;
  };
  /** Deliver everything in flight, and let served calls answer. */
  settle(): Promise<void>;
  /** Cut the link with whatever was in flight. */
  drop(): void;
  /**
   * Restart one side as a new process naming `features`, and connect again.
   * The agreed set is worked out afresh from the new hellos.
   */
  restart(side: 'home' | 'computer', features: readonly string[]): Promise<WireEnds>;
}

/** A home faced by a computer that skips its own checks. */
export interface UncheckedEnds {
  /** The home's end. */
  readonly home: WireHomeView;
  /** Send one call as is, and return the home's answer to it. */
  send(call: RelayCall): Promise<WireCallOutcome>;
}

/** One way of running a case: in process, or over the wire. */
export interface WireRunner {
  /** `in process` or `over the wire`. */
  readonly name: string;
  /** Connect a fake computer to a fake home. */
  start(options: WireStart): Promise<WireEnds>;
  /** Connect a computer that sends whatever it is handed. */
  startUnchecked(options: WireStart): Promise<UncheckedEnds>;
}

/** One case, written once and run under both runners. */
export interface WireCase {
  /** What it proves. */
  name: string;
  /** Run it; throw (or fail an `expect`) to fail. */
  run(runner: WireRunner): Promise<void>;
}

/** The home's link and the computer's link, as the server builds them. */
export interface InProcessParts {
  /** The home's link for a computer that proved itself with `hello`. */
  homeLink(
    hello: readonly string[],
    home: FakeHome,
    send: (text: string) => boolean
  ): {
    readonly agreed: readonly string[];
    readonly featuresFrame: object | null;
    read(inner: string): { kind: string };
  };
  /** The computer's link, for a connection whose `hello` named `named`. */
  computerLink(named: readonly string[]): {
    readonly agreed: readonly string[];
    read(inner: string): { kind: string };
    call(call: RelayCall, send: (text: string) => boolean): Promise<WireCallOutcome>;
    closeAll(): void;
  };
}

/** The real ends, as the server builds them on a socket. */
export interface OverWireParts {
  /** The home's connection on `socket`, for an agent computer, experiment on. */
  home(
    socket: WireSocket,
    home: FakeHome
  ): {
    readonly connected: boolean;
    readonly agreedFeatures: readonly string[];
  };
  /** A new computer process: its dialer, connecting with `connect`. */
  computer(
    connect: () => WireSocket,
    server: FakeComputer
  ): {
    readonly connected: boolean;
    readonly agreedFeatures: readonly string[];
    call(call: RelayCall): Promise<WireCallOutcome>;
    /** Dial, as a `viewer_open` would. */
    open(): void;
  };
  /** A computer that runs the real handshake, then seals whatever it is handed. */
  rawComputer(
    socket: WireSocket,
    features: readonly string[]
  ): { send(frame: unknown): void; readonly received: WireInnerFrame[] };
}

/** Everything {@link wireConformance} needs from the server. */
export interface WireParts {
  inProcess: InProcessParts;
  overWire: OverWireParts;
}

/** The cases every step has added. */
export const WIRE_CASES: readonly WireCase[] = [...HELLO_CASES];

/**
 * Register every case, each run in process and over the wire.
 *
 * @param parts - The server's real pieces.
 * @param cases - Override for a narrower run; every case by default.
 */
export function wireConformance(parts: WireParts, cases: readonly WireCase[] = WIRE_CASES): void {
  describe('wire conformance (in process and over the wire)', () => {
    for (const wireCase of cases) {
      it(wireCase.name, () =>
        runWireCase(wireCase, [inProcessRunner(parts.inProcess), overWireRunner(parts.overWire)])
      );
    }
  });
}

/**
 * Run one case under every runner, and fail it when a runner never started
 * its ends: a case that passes one way and quietly skips the other fails.
 * Every connection a run started is dropped afterwards.
 *
 * @param wireCase - The case.
 * @param runners - The runners, each run in turn.
 */
export async function runWireCase(
  wireCase: WireCase,
  runners: readonly WireRunner[]
): Promise<void> {
  for (const runner of runners) {
    const opened: { drop(): void }[] = [];
    const watched: WireRunner = {
      name: runner.name,
      start: async (options) => {
        const ends = await runner.start(options);
        opened.push(ends);
        return ends;
      },
      startUnchecked: (options) => {
        opened.push({ drop: () => undefined });
        return runner.startUnchecked(options);
      },
    };
    try {
      await wireCase.run(watched);
    } finally {
      for (const ends of opened) ends.drop();
    }
    if (opened.length === 0) {
      throw new Error(`${wireCase.name}: the ${runner.name} run never started its ends`);
    }
  }
}

/** Deliver what is queued, letting promise answers land between rounds. */
async function drain(pump: () => void): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    pump();
    await Promise.resolve();
  }
}

/** The outcome a `call.result` frame carries. */
function outcomeOf(frame: Partial<WireInnerFrame>): WireCallOutcome {
  return frame.ok === true
    ? { ok: true, body: frame.body }
    : { ok: false, error: frame.error as RelayError };
}

/**
 * The in-process runner: the server's two links, joined by a queue. The
 * shapes that cross are the shapes the wire carries, with no channel.
 *
 * @param parts - The server's links.
 */
export function inProcessRunner(parts: InProcessParts): WireRunner {
  const start = async (options: WireStart): Promise<WireEnds> => {
    const queue: (() => void)[] = [];
    let up = true;
    let sent = 0;
    const home = fakeHome(options.home, options.hold);
    const computer = parts.computerLink(options.computer);
    const toComputer = (text: string): boolean => {
      if (!up) return false;
      queue.push(() => {
        if (up && computer.read(text).kind === 'close') up = false;
      });
      return true;
    };
    const link = parts.homeLink(options.computer, home, toComputer);
    const toHome = (text: string): boolean => {
      if (!up) return false;
      sent += 1;
      queue.push(() => {
        if (up && link.read(text).kind === 'close') up = false;
      });
      return true;
    };
    if (link.featuresFrame) toComputer(JSON.stringify(link.featuresFrame));
    const pump = () => {
      while (queue.length > 0) queue.shift()!();
    };
    pump();
    const ends: WireEnds = {
      home: { agreed: () => link.agreed, connected: () => up, served: home.served },
      computer: {
        agreed: () => (up ? computer.agreed : []),
        connected: () => up,
        call: (call) => computer.call(call, toHome),
        sent: () => sent,
      },
      settle: () => drain(pump),
      drop: () => {
        up = false;
        queue.length = 0;
        computer.closeAll();
      },
      restart: async (side, features) => {
        ends.drop();
        return start(
          side === 'home'
            ? { ...options, home: features as readonly RelayCallFeature[] }
            : { ...options, computer: features }
        );
      },
    };
    return ends;
  };
  return {
    name: 'in process',
    start,
    startUnchecked: async (options) => {
      const home = fakeHome(options.home, options.hold);
      const answers: WireInnerFrame[] = [];
      const link = parts.homeLink(options.computer, home, (text) => {
        answers.push(JSON.parse(text));
        return true;
      });
      let up = true;
      let nextId = 0;
      return {
        home: { agreed: () => link.agreed, connected: () => up, served: home.served },
        send: async (call) => {
          nextId += 1;
          const id = `u${nextId}`;
          if (link.read(JSON.stringify({ type: 'call', id, call })).kind === 'close') up = false;
          await drain(() => undefined);
          return outcomeOf(answers.find((frame) => frame.id === id) ?? {});
        },
      };
    },
  };
}

/**
 * The over-the-wire runner: the real dialer and the real hub connection, with
 * the real channel cryptography, over the in-memory socket pair.
 *
 * @param parts - The server's real ends.
 */
export function overWireRunner(parts: OverWireParts): WireRunner {
  const start = async (options: WireStart): Promise<WireEnds> => {
    let wire = new Wire();
    let home = fakeHome(options.home, options.hold);
    let homeEnd: ReturnType<OverWireParts['home']> | null = null;
    // Each dial meets a new home connection, as the real endpoint makes one.
    const connect = () => {
      homeEnd = parts.home(wire.hub, home);
      return wire.computer;
    };
    let computer = parts.computer(connect, fakeComputer(options.computer));
    let handshake = 0;
    const dial = () => {
      computer.open();
      wire.computer.fire('open');
      wire.pump();
      handshake = wire.computer.sent.length;
    };
    dial();
    const ends: WireEnds = {
      home: {
        agreed: () => homeEnd?.agreedFeatures ?? [],
        connected: () => homeEnd?.connected === true,
        get served() {
          return home.served;
        },
      },
      computer: {
        agreed: () => computer.agreedFeatures,
        connected: () => computer.connected,
        call: (call) => computer.call(call),
        sent: () => wire.computer.sent.length - handshake,
      },
      settle: () => drain(() => wire.pump()),
      drop: () => wire.drop(),
      restart: async (side, features) => {
        wire.drop();
        wire = new Wire();
        // A restarted home is a new home process; the computer dials it again.
        if (side === 'home') home = fakeHome(features as readonly RelayCallFeature[], options.hold);
        // A restarted computer is a new process with a new dialer.
        else computer = parts.computer(connect, fakeComputer(features));
        dial();
        return ends;
      },
    };
    return ends;
  };
  return {
    name: 'over the wire',
    start,
    startUnchecked: async (options) => {
      const home = fakeHome(options.home, options.hold);
      const wire = new Wire();
      const homeEnd = parts.home(wire.hub, home);
      const raw = parts.rawComputer(wire.computer, options.computer);
      wire.pump();
      let nextId = 0;
      return {
        home: {
          agreed: () => homeEnd.agreedFeatures,
          connected: () => homeEnd.connected,
          served: home.served,
        },
        send: async (call) => {
          nextId += 1;
          const id = `u${nextId}`;
          raw.send({ type: 'call', id, call });
          await drain(() => wire.pump());
          const answer = raw.received.find(
            (frame) => frame.type === 'call.result' && frame.id === id
          );
          return outcomeOf(answer ?? {});
        },
      };
    },
  };
}
