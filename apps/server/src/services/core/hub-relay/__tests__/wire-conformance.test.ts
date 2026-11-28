/**
 * @vitest-environment node
 *
 * The wire conformance suite (spec `space-computer-contract` §12, step W3) on
 * this server's real pieces: in process, the home's `AgentComputerLink` and
 * the computer's `HubFeatureLink` joined with no channel; over the wire, the
 * real `HubComputerConnection` and `RelayDialer` with the real channel
 * cryptography. `@dorkos/test-utils` holds the cases and the runners; this
 * file only hands them the parts, since that package never imports the server.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import {
  RelaySealedFrameSchema,
  decodeRelayFrame,
  encodeRelayFrame,
} from '@dorkos/shared/session-relay';
import type { WireSocket } from '@dorkos/test-utils/relay-socket-pair';
import {
  wireConformance,
  type WireInnerFrame,
  type WireParts,
} from '@dorkos/test-utils/wire-conformance';
import {
  finishComputerHandshake,
  pinnableKey,
  startComputerHandshake,
  type RelayChannel,
} from '../../session-relay/channel.js';
import { RelayDialer } from '../../session-relay/relay-dialer.js';
import type { RelayPin } from '../../session-relay/pin-store.js';
import { HubFeatureLink } from '../../session-relay/wire-clients/hub-features.js';
import { AgentComputerLink } from '../agent-computer-hello.js';
import { HubComputerConnection } from '../computer-connection.js';

const ORIGIN = 'https://home.example.test';
const LATER = '2099-01-01T00:00:00.000Z';
const hubKey = generateKeyPairSync('ed25519').privateKey;
const computerKey: KeyObject = generateKeyPairSync('ed25519').privateKey;
/** The home's record of this computer: an agent computer, experiment on. */
const AGENT_COMPUTER = { role: 'agent-computer', agentComputers: () => true } as const;

const pin: RelayPin = {
  v: 2,
  computerId: 'computer-1',
  hubOrigin: ORIGIN,
  hubKey: pinnableKey(hubKey),
  relaySecret: randomBytes(32).toString('base64url'),
  pinnedAt: '2026-11-28T00:00:00.000Z',
  computerName: 'Build box',
  level: 'chat',
  paused: false,
};

const parts: WireParts = {
  inProcess: {
    homeLink: (hello, home, send) => {
      const link = AgentComputerLink.open({ ...AGENT_COMPUTER, calls: home }, hello, send);
      if (!link) throw new Error('an agent computer’s home always opens its link');
      return link;
    },
    computerLink: (named) => new HubFeatureLink(named),
  },
  overWire: {
    home: (socket, home) =>
      new HubComputerConnection({
        socket,
        computer: { computerId: pin.computerId, computerKey: pinnableKey(computerKey) },
        signer: { sign: (data) => sign(null, data, hubKey), origin: ORIGIN },
        ...AGENT_COMPUTER,
        calls: home,
      }),
    computer: (connect, server) => {
      const dialer = new RelayDialer({
        readPin: () => pin,
        ownerExists: () => true,
        computerKey: () => computerKey,
        appVersion: '0.143.0',
        server,
        connect,
      });
      return {
        get connected() {
          return dialer.connected;
        },
        get agreedFeatures() {
          return dialer.agreedFeatures;
        },
        call: (call) => dialer.call(call),
        open: () => void dialer.onViewerOpen(LATER),
      };
    },
    rawComputer: (socket: WireSocket, features) => {
      const handshake = startComputerHandshake(pin.computerId, features, '0.143.0');
      let channel: RelayChannel | null = null;
      const received: WireInnerFrame[] = [];
      socket.on('message', (data: unknown) => {
        const text = String(data);
        if (!channel) {
          const finished = finishComputerHandshake(handshake, text, {
            hubOrigin: ORIGIN,
            hubKey: pin.hubKey,
            computerKey,
          });
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
    },
  },
};

wireConformance(parts);
