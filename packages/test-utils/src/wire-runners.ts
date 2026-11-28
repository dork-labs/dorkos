/**
 * The two runners of the wire conformance suite (spec
 * `space-computer-contract` §12, step W3): in process, and over the wire.
 * Both give a case the same ends ({@link WireEnds}), so a case is written
 * once. Neither imports the server; the server hands its pieces in.
 *
 * @module test-utils/wire-runners
 */
import type { RelayCallFeature } from '@dorkos/shared/session-relay-agent-computer';
import type { RelayError } from '@dorkos/shared/session-relay';
import { Wire } from './relay-socket-pair.js';
import { fakeComputer, fakeHome, type FakeHome } from './wire-fakes.js';
import type {
  InProcessParts,
  OverWireParts,
  UncheckedEnds,
  WireCallOutcome,
  WireEnds,
  WireInnerFrame,
  WireRunner,
  WireStart,
} from './wire-conformance.js';

/** Most rounds {@link settle} runs before it says something never settles. */
const SETTLE_MAX_ROUNDS = 200;

/**
 * Deliver what is queued until nothing is left in flight: pump, let the
 * event loop turn (so served calls answer), and repeat until the queue stays
 * empty across a turn. A call held on purpose is not in flight; it simply
 * never answers.
 *
 * @param pump - Deliver everything queued now.
 * @param pending - How many deliveries are queued.
 */
async function settle(pump: () => void, pending: () => number): Promise<void> {
  let quiet = 0;
  for (let round = 0; round < SETTLE_MAX_ROUNDS; round += 1) {
    pump();
    await new Promise<void>((resolve) => setImmediate(resolve));
    quiet = pending() === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return;
  }
  throw new Error(`settle: frames still in flight after ${SETTLE_MAX_ROUNDS} rounds`);
}

/** The outcome a `call.result` frame carries. */
function outcomeOf(frame: Partial<WireInnerFrame>): WireCallOutcome {
  return frame.ok === true
    ? { ok: true, body: frame.body }
    : { ok: false, error: frame.error as RelayError };
}

/** The ends' options after one side restarted naming `features`. */
function restarted(
  options: WireStart,
  side: 'home' | 'computer',
  features: readonly string[]
): WireStart {
  return side === 'home'
    ? { ...options, home: features as readonly RelayCallFeature[] }
    : { ...options, computer: features };
}

/**
 * One in-process connection: the two links and a queue between them. Each
 * side has its own `up`: the side that closes knows at once, and the other
 * learns at the next delivery, as over a socket.
 */
class InProcessConnection {
  homeUp = true;
  computerUp = true;
  sent = 0;
  readonly queue: (() => void)[] = [];
  readonly computer: ReturnType<InProcessParts['computerLink']>;
  readonly link: ReturnType<InProcessParts['homeLink']>;

  constructor(
    parts: InProcessParts,
    options: WireStart,
    readonly home: FakeHome
  ) {
    this.computer = parts.computerLink(options.computer);
    this.link = parts.homeLink(options.computer, home, this.toComputer, options.now);
    // The home's connection sends the features frame first, then nothing else.
    if (this.link.featuresFrame) this.toComputer(JSON.stringify(this.link.featuresFrame));
    this.pump();
  }

  /** The home sends one frame to the computer. */
  readonly toComputer = (text: string): boolean => {
    if (!this.homeUp) return false;
    this.queue.push(() => {
      if (this.computerUp && this.computer.read(text).kind === 'close') this.computerClosed();
    });
    return true;
  };

  /** The computer sends one frame to the home. */
  readonly toHome = (text: string): boolean => {
    if (!this.computerUp) return false;
    this.sent += 1;
    this.queue.push(() => {
      if (this.homeUp && this.link.read(text).kind === 'close') this.homeClosed();
    });
    return true;
  };

  /** Deliver everything queued. */
  pump(): void {
    while (this.queue.length > 0) this.queue.shift()!();
  }

  /** Cut the link: both sides hear it now, and nothing in flight lands. */
  drop(): void {
    this.homeUp = false;
    this.computerUp = false;
    this.computer.closeAll();
    this.queue.length = 0;
  }

  private computerClosed(): void {
    this.computerUp = false;
    this.computer.closeAll();
    this.queue.push(() => {
      this.homeUp = false;
    });
  }

  private homeClosed(): void {
    this.homeUp = false;
    this.queue.push(() => {
      this.computerUp = false;
      this.computer.closeAll();
    });
  }
}

/**
 * The in-process runner: the server's two links, joined by a queue. The
 * shapes that cross are the shapes the wire carries, with no channel.
 *
 * @param parts - The server's links.
 */
export function inProcessRunner(parts: InProcessParts): WireRunner {
  return {
    name: 'in process',
    start: async (options) => {
      let current = new InProcessConnection(parts, options, fakeHome(options.home, options.hold));
      let opts = options;
      const ends: WireEnds = {
        home: {
          agreed: () => current.link.agreed,
          connected: () => current.homeUp,
          get served() {
            return current.home.served;
          },
        },
        computer: {
          agreed: () => (current.computerUp ? current.computer.agreed : []),
          connected: () => current.computerUp,
          call: (call) => current.computer.call(call, current.toHome),
          sent: () => current.sent,
        },
        settle: () =>
          settle(
            () => current.pump(),
            () => current.queue.length
          ),
        drop: () => current.drop(),
        restart: async (side, features) => {
          current.drop();
          opts = restarted(opts, side, features);
          // A restarted home is a new home process; a restarted computer meets the same home.
          const home = side === 'home' ? fakeHome(opts.home, opts.hold) : current.home;
          current = new InProcessConnection(parts, opts, home);
          return ends;
        },
      };
      return ends;
    },
    startUnchecked: async (options): Promise<UncheckedEnds> => {
      const home = fakeHome(options.home, options.hold);
      const received: WireInnerFrame[] = [];
      let up = true;
      const link = parts.homeLink(
        options.computer,
        home,
        (text) => {
          if (!up) return false;
          received.push(JSON.parse(text));
          return true;
        },
        options.now
      );
      if (link.featuresFrame) received.push(JSON.parse(JSON.stringify(link.featuresFrame)));
      let nextId = 0;
      return {
        home: { agreed: () => link.agreed, connected: () => up, served: home.served },
        received: () => received,
        send: async (call) => {
          nextId += 1;
          const id = `u${nextId}`;
          if (up && link.read(JSON.stringify({ type: 'call', id, call })).kind === 'close') {
            up = false;
          }
          await settle(
            () => undefined,
            () => 0
          );
          return outcomeOf(received.find((frame) => frame.id === id) ?? {});
        },
        drop: () => {
          up = false;
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
  return {
    name: 'over the wire',
    start: async (options) => {
      let opts = options;
      let wire = new Wire();
      let home = fakeHome(options.home, options.hold);
      let homeEnd: ReturnType<OverWireParts['home']> | null = null;
      // Each dial meets a new home connection, as the real endpoint makes one.
      const connect = () => {
        homeEnd = parts.home(wire.hub, home, opts.now);
        return wire.computer;
      };
      let computer = parts.computer(connect, fakeComputer(options.computer), options.now);
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
        settle: () =>
          settle(
            () => wire.pump(),
            () => wire.queue.length
          ),
        drop: () => wire.drop(),
        restart: async (side, features) => {
          wire.drop();
          wire = new Wire();
          opts = restarted(opts, side, features);
          // A restarted home is a new home process; the computer dials it again.
          if (side === 'home') home = fakeHome(opts.home, opts.hold);
          // A restarted computer is a new process with a new dialer.
          else computer = parts.computer(connect, fakeComputer(opts.computer), opts.now);
          dial();
          return ends;
        },
      };
      return ends;
    },
    startUnchecked: async (options): Promise<UncheckedEnds> => {
      const home = fakeHome(options.home, options.hold);
      const wire = new Wire();
      const homeEnd = parts.home(wire.hub, home, options.now);
      const raw = parts.rawComputer(wire.computer, options.computer);
      wire.pump();
      let nextId = 0;
      return {
        home: {
          agreed: () => homeEnd.agreedFeatures,
          connected: () => homeEnd.connected,
          served: home.served,
        },
        received: () => raw.received,
        send: async (call) => {
          nextId += 1;
          const id = `u${nextId}`;
          raw.send({ type: 'call', id, call });
          await settle(
            () => wire.pump(),
            () => wire.queue.length
          );
          const answer = raw.received.find(
            (frame) => frame.type === 'call.result' && frame.id === id
          );
          return outcomeOf(answer ?? {});
        },
        drop: () => wire.drop(),
      };
    },
  };
}
