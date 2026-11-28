/**
 * The fake home and the fake computer the wire conformance suite connects
 * (spec `space-computer-contract` §12, step W3). Each is what sits behind one
 * end of the channel: the home's call server and the computer's request
 * server. Neither knows how it is reached, so the same pair runs in process
 * and over the wire.
 *
 * Later steps grow them: the fake home gains the turn port's space face, and
 * the fake computer the test runtime behind its computer face.
 *
 * @module test-utils/wire-fakes
 */
import type { RelayCall, RelayCallFeature } from '@dorkos/shared/session-relay-agent-computer';
import type { RelayComputerFrame, RelayWebFrame } from '@dorkos/shared/session-relay';

/** The home's side: the calls it serves, and a record of every call it served. */
export interface FakeHome {
  /** The calls this home serves: what its `features` frame names. */
  readonly features: readonly RelayCallFeature[];
  /** Every call served, in order. */
  readonly served: RelayCall[];
  /** Serve one call. A held feature never answers, so a drop can land mid-call. */
  serve(call: RelayCall): Promise<unknown>;
}

/**
 * A home that serves `features`, answering `tools.list` with no tools and
 * `computer.status` with `ok`. Calls whose feature is in `hold` never answer.
 *
 * @param features - The calls it serves.
 * @param hold - Calls it takes and never answers.
 */
export function fakeHome(
  features: readonly RelayCallFeature[],
  hold: readonly RelayCallFeature[] = []
): FakeHome {
  const served: RelayCall[] = [];
  return {
    features,
    served,
    serve: (call) => {
      served.push(call);
      if (hold.includes(call.op)) return new Promise<never>(() => undefined);
      if (call.op === 'tools.list') return Promise.resolve({ tools: [] });
      if (call.op === 'computer.status') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true, output: 'done' });
    },
  };
}

/** The computer's side: the request server behind its relay connection. */
export interface FakeComputer {
  /** The features it names in `hello`. */
  features(): readonly string[];
  /** Answer one frame from the home; `chats.list` gets an empty list. */
  handle(frame: RelayWebFrame, emit: (frame: RelayComputerFrame) => void): void;
  /** The connection ended. */
  closeAll(): void;
  /** No streams are open here. */
  endStream(): boolean;
  /** Every frame the home sent it, in order. */
  readonly handled: RelayWebFrame[];
}

/**
 * A computer that names `features` and answers `chats.list`.
 *
 * @param features - What it names in `hello`.
 */
export function fakeComputer(features: readonly string[]): FakeComputer {
  const handled: RelayWebFrame[] = [];
  return {
    features: () => features,
    handled,
    handle(frame, emit) {
      handled.push(frame);
      if (frame.type === 'request' && frame.request.op === 'chats.list') {
        emit({ type: 'result', id: frame.id, ok: true, body: { chats: [] } });
      }
    },
    closeAll: () => undefined,
    endStream: () => false,
  };
}
