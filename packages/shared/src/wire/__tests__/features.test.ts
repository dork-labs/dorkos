import { describe, expect, it } from 'vitest';
import {
  RelayHelloFrameSchema,
  SESSION_RELAY_FEATURES,
  decodeRelayFrame,
  encodeRelayFrame,
} from '../../session-relay.js';
import { AgentComputerWebFrameSchema } from '../../session-relay-agent-computer.js';
import {
  AGENT_COMPUTER_FEATURES,
  AGENT_COMPUTER_RELAY_FEATURES,
  RELAY_CALL_FEATURES,
  REMOTE_COMPUTER_MIN_FEATURES,
  WIRE_FEATURES,
  agreedAgentComputerFeatures,
  homeFeaturesFrameFor,
  wireFeatureRefusal,
} from '../features.js';

const HELLO = {
  type: 'hello',
  computerId: 'computer-1',
  versions: { min: 1, max: 1 },
  appVersion: '0.143.0',
  nonce: 'A'.repeat(43),
  ephemeralKey: 'B'.repeat(43),
};

describe('the feature vocabulary', () => {
  it('H5: names every id once, in the wire’s own characters, with room under the cap of 64', () => {
    expect(new Set(WIRE_FEATURES).size).toBe(WIRE_FEATURES.length);
    expect(WIRE_FEATURES.length).toBeLessThanOrEqual(56);
    const hello = { ...HELLO, features: [...WIRE_FEATURES] };
    expect(RelayHelloFrameSchema.safeParse(hello).success).toBe(true);
  });

  it('keeps the chat set apart, and covers every shaped operation and the minimum set', () => {
    for (const id of SESSION_RELAY_FEATURES) {
      expect(AGENT_COMPUTER_FEATURES as readonly string[]).not.toContain(id);
    }
    for (const id of [...AGENT_COMPUTER_RELAY_FEATURES, ...RELAY_CALL_FEATURES]) {
      expect(AGENT_COMPUTER_FEATURES as readonly string[]).toContain(id);
    }
    for (const id of REMOTE_COMPUTER_MIN_FEATURES) {
      expect(WIRE_FEATURES as readonly string[]).toContain(id);
    }
  });

  it('round-trips the features frame through the wire', () => {
    const frame = homeFeaturesFrameFor(['tools.list'], ['tools.list', 'computer.status'])!;
    const text = encodeRelayFrame(frame)!;
    expect(decodeRelayFrame(text, AgentComputerWebFrameSchema)).toEqual(frame);
  });
});

describe('the agreed set', () => {
  it('is the intersection of both lists, never wider than either', () => {
    const computer = ['chats.list', 'tools.list', 'tools.call', 'zz.unknown'];
    const home = ['tools.call', 'computer.status', 'zz.unknown'];
    const agreed = agreedAgentComputerFeatures(computer, home);
    expect(agreed).toEqual(['tools.call']);
    for (const id of agreed) {
      expect(computer).toContain(id);
      expect(home).toContain(id);
    }
  });

  it('never holds an id this build does not know, even when both name it', () => {
    expect(agreedAgentComputerFeatures(['zz.unknown'], ['zz.unknown'])).toEqual([]);
  });

  it('is empty when the home sent nothing', () => {
    expect(agreedAgentComputerFeatures([...AGENT_COMPUTER_FEATURES], [])).toEqual([]);
  });

  it('sends no frame to a computer that named no agent-computer feature', () => {
    expect(
      homeFeaturesFrameFor([...SESSION_RELAY_FEATURES, 'zz.unknown'], ['tools.list'])
    ).toBeNull();
    expect(homeFeaturesFrameFor(['tools.call'], [])).toEqual({ type: 'features', features: [] });
  });
});

describe('what a hello may name', () => {
  it('refuses, never trims, a list past its bounds', () => {
    const lists = [
      Array.from({ length: 65 }, (_, i) => `f${i}`),
      ['x'.repeat(65)],
      ['Tools.Call'],
      ['tools call'],
      [''],
    ];
    for (const features of lists) {
      expect(RelayHelloFrameSchema.safeParse({ ...HELLO, features }).success).toBe(false);
    }
    const most = Array.from({ length: 64 }, (_, i) => `f-${i}.x_y`);
    expect(RelayHelloFrameSchema.safeParse({ ...HELLO, features: most }).success).toBe(true);
  });
});

describe('the refusal', () => {
  it('names a known feature, and names nothing for a call it could not read', () => {
    expect(wireFeatureRefusal('tools.call')).toMatchObject({
      status: 501,
      code: 'needs_update',
      feature: 'tools.call',
    });
    expect(wireFeatureRefusal()).toEqual({
      status: 501,
      code: 'needs_update',
      message: expect.any(String),
    });
  });
});
