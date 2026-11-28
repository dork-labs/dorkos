/**
 * A computer that runs the real relay handshake on a socket and then seals
 * whatever the test hands it, skipping every check a real dialer makes: how a
 * test sends a home the frames a well-behaved computer never would.
 */
import type { KeyObject } from 'node:crypto';
import {
  RelaySealedFrameSchema,
  decodeRelayFrame,
  encodeRelayFrame,
} from '@dorkos/shared/session-relay';
import type { WireSocket } from '@dorkos/test-utils/relay-socket-pair';
import type { WireInnerFrame } from '@dorkos/test-utils/wire-conformance';
import {
  finishComputerHandshake,
  startComputerHandshake,
  type RelayChannel,
} from '../../session-relay/channel.js';

/** What the raw computer needs to prove itself to its home. */
export interface RawComputerKeys {
  computerId: string;
  hubOrigin: string;
  /** The home's key as the computer pinned it. */
  hubKey: string;
  computerKey: KeyObject;
}

/**
 * Say hello on `socket` naming `features`, finish the handshake when the home
 * answers, then record every frame the home sends.
 *
 * @param socket - The computer's end of the socket pair.
 * @param features - What its `hello` names.
 * @param keys - Its id, its home's pinned origin and key, and its own key.
 */
export function rawComputerOn(
  socket: WireSocket,
  features: readonly string[],
  keys: RawComputerKeys
): { send(frame: unknown): void; readonly received: WireInnerFrame[] } {
  const handshake = startComputerHandshake(keys.computerId, features, '0.143.0');
  let channel: RelayChannel | null = null;
  const received: WireInnerFrame[] = [];
  socket.on('message', (data: unknown) => {
    const text = String(data);
    if (!channel) {
      const finished = finishComputerHandshake(handshake, text, keys);
      if (!finished.ok) throw new Error('the handshake failed');
      channel = finished.channel;
      socket.send(encodeRelayFrame(finished.finish)!);
      return;
    }
    const inner = channel.open(decodeRelayFrame(text, RelaySealedFrameSchema)!);
    received.push(JSON.parse(inner!));
  });
  socket.send(handshake.helloText);
  return {
    received,
    send: (frame) => socket.send(encodeRelayFrame(channel!.seal(JSON.stringify(frame))!)!),
  };
}
