/**
 * The wire conformance suite (spec `space-computer-contract` §12, step W3).
 *
 * Every case runs twice (invariant N1): once **in process**, with the home's
 * link and the computer's link joined by a plain queue and no channel, and
 * once **over the wire**, with the real dialer, the real hub connection and the
 * real channel cryptography over the in-memory socket pair. A case passes only
 * when both runs pass, and each run must really start its ends and really
 * assert something ({@link runWireCase}).
 *
 * This package never imports the server (the server depends on it), so the
 * server hands its real pieces in ({@link WireParts}), the way
 * `runtimeConformance` takes a runtime factory. The runners are in
 * `wire-runners.ts`.
 *
 * **Adding a case.** A step writes its cases in `wire-cases/<step>.ts` as
 * {@link WireCase}s, written once against {@link WireRunner}, and adds them to
 * {@link WIRE_CASES}. Nothing else changes: the server's one call to
 * {@link wireConformance} runs them both ways.
 *
 * @module test-utils/wire-conformance
 */
import { describe, expect, it } from 'vitest';
import type { RelayCall, RelayCallFeature } from '@dorkos/shared/session-relay-agent-computer';
import type { RelayError } from '@dorkos/shared/session-relay';
import type { WireSocket } from './relay-socket-pair.js';
import type { FakeComputer, FakeHome } from './wire-fakes.js';
import { HELLO_CASES } from './wire-cases/hello.js';
import { inProcessRunner, overWireRunner } from './wire-runners.js';

export { fakeComputer, fakeHome, type FakeComputer, type FakeHome } from './wire-fakes.js';
export { inProcessRunner, overWireRunner } from './wire-runners.js';

/** A call's outcome as the computer sees it: the answer body, or why there is none. */
export type WireCallOutcome = { ok: true; body: unknown } | { ok: false; error: RelayError };

/** One opened inner frame, as a raw end reads it. */
export interface WireInnerFrame {
  type: string;
  id?: unknown;
  ok?: unknown;
  body?: unknown;
  error?: unknown;
  features?: unknown;
}

/** What both ends are started with. */
export interface WireStart {
  /** What the computer names in its `hello`. */
  computer: readonly string[];
  /** The calls the home serves. */
  home: readonly RelayCallFeature[];
  /** Calls the home takes and never answers, so a drop can land mid-call. */
  hold?: readonly RelayCallFeature[];
  /** The clock both ends read; `Date.now` when not given. */
  now?: () => number;
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
    /** How many frames the computer has sent since the hello. */
    sent(): number;
  };
  /** Deliver everything in flight, and let served calls answer. */
  settle(): Promise<void>;
  /** Cut the link with whatever was in flight. */
  drop(): void;
  /**
   * Restart one side as a new process naming `features`, and connect again.
   * The agreed set is worked out afresh from the new hellos. Returns these
   * same ends, now on the new connection.
   */
  restart(side: 'home' | 'computer', features: readonly string[]): Promise<WireEnds>;
}

/** A home faced by a computer that skips its own checks. */
export interface UncheckedEnds {
  /** The home's end. */
  readonly home: WireHomeView;
  /** Every frame the home sent this computer, in order. */
  received(): readonly WireInnerFrame[];
  /** Send one call as is, and return the home's answer to it. */
  send(call: RelayCall): Promise<WireCallOutcome>;
  /** Cut the link. */
  drop(): void;
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
    send: (text: string) => boolean,
    now?: () => number
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
    home: FakeHome,
    now?: () => number
  ): {
    readonly connected: boolean;
    readonly agreedFeatures: readonly string[];
  };
  /** A new computer process: its dialer, connecting with `connect`. */
  computer(
    connect: () => WireSocket,
    server: FakeComputer,
    now?: () => number
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
 * Run one case under every runner. A run fails, named by its runner, when the
 * case fails, when it never started its ends, or when it asserted nothing: a
 * case that passes one way and quietly skips or idles the other fails. Every
 * connection a run started is dropped afterwards.
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
      startUnchecked: async (options) => {
        // Counted as started before it resolves, and dropped once it has.
        const slot = { drop: () => undefined as void };
        opened.push(slot);
        const ends = await runner.startUnchecked(options);
        slot.drop = () => ends.drop();
        return ends;
      },
    };
    const assertionsBefore = expect.getState().assertionCalls;
    try {
      await wireCase.run(watched);
    } catch (error) {
      throw new Error(`${runner.name}: ${(error as Error).message}`, { cause: error });
    } finally {
      for (const ends of opened) ends.drop();
    }
    if (opened.length === 0) {
      throw new Error(`${runner.name}: ${wireCase.name}: the run never started its ends`);
    }
    if (expect.getState().assertionCalls === assertionsBefore) {
      throw new Error(`${runner.name}: ${wireCase.name}: the run asserted nothing`);
    }
  }
}
