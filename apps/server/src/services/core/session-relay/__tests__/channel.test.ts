/**
 * @vitest-environment node
 *
 * The session relay's secure channel: the handshake proves the hub with the
 * key the computer pinned and the computer with the key the hub pinned, and
 * every later frame is sealed so nobody in the middle can read, replay,
 * reorder or inject one.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encodeRelayFrame,
  relayWelcomeTranscript,
  SESSION_RELAY_MAX_INNER_FRAME_BYTES,
} from '@dorkos/shared/session-relay';
import {
  answerHello,
  finishComputerHandshake,
  pinnableKey,
  startComputerHandshake,
  type HubIdentity,
} from '../channel.js';

const ORIGIN = 'https://hub.example.test';
const COMPUTER_ID = 'computer-1';

function newHub(): HubIdentity & { pinned: string; signingKey: KeyObject } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    sign: (data) => sign(null, data, privateKey),
    signingKey: privateKey,
    origin: ORIGIN,
    pinned: pinnableKey(privateKey),
  };
}

function newComputer(): { key: KeyObject; pinned: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pinned: pinnableKey(privateKey) };
}

/** A full handshake between a computer and its hub, each pinning the other. */
function connect(hub = newHub(), computer = newComputer()) {
  const handshake = startComputerHandshake(COMPUTER_ID, ['session.stream'], '0.118.0');
  const answered = answerHello(handshake.helloText, COMPUTER_ID, hub);
  if (!answered.ok || !answered.pending) throw new Error('hub refused');
  const finished = finishComputerHandshake(handshake, JSON.stringify(answered.answer), {
    hubOrigin: hub.origin,
    hubKey: hub.pinned,
    computerKey: computer.key,
  });
  if (!finished.ok) throw new Error(`computer refused: ${finished.reason}`);
  const hubChannel = answered.pending.acceptFinish(finished.finish, computer.pinned);
  if (!hubChannel) throw new Error('hub did not accept finish');
  return { computer: finished.channel, hub: hubChannel };
}

const frame = (n: number) => encodeRelayFrame({ type: 'viewers', count: n })!;

describe('the handshake', () => {
  it('connects a computer and its hub, each proving itself, and both ends talk', () => {
    const { computer, hub } = connect();
    expect(computer.open(hub.seal(frame(1))!)).toBe(frame(1));
    const reply = encodeRelayFrame({ type: 'heartbeat' })!;
    expect(hub.open(computer.seal(reply)!)).toBe(reply);
  });

  it('refuses a hub that does not hold the pinned key, even at the pinned address', () => {
    const real = newHub();
    const impostor = newHub();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
    const answered = answerHello(handshake.helloText, COMPUTER_ID, impostor);
    if (!answered.ok) throw new Error('unexpected');

    const result = finishComputerHandshake(handshake, JSON.stringify(answered.answer), {
      hubOrigin: ORIGIN,
      hubKey: real.pinned,
      computerKey: newComputer().key,
    });
    expect(result).toEqual({ ok: false, reason: 'unverified' });
  });

  it('refuses a computer that does not hold its pinned key, even with its relay credential', () => {
    // Someone who stole the credential runs their own handshake as the computer.
    const hub = newHub();
    const realComputer = newComputer();
    const thief = newComputer();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
    const answered = answerHello(handshake.helloText, COMPUTER_ID, hub);
    if (!answered.ok || !answered.pending) throw new Error('unexpected');
    const finished = finishComputerHandshake(handshake, JSON.stringify(answered.answer), {
      hubOrigin: ORIGIN,
      hubKey: hub.pinned,
      computerKey: thief.key,
    });
    if (!finished.ok) throw new Error('unexpected');

    expect(answered.pending.acceptFinish(finished.finish, realComputer.pinned)).toBeNull();
  });

  it('never answers a hello naming another computer than the credential belongs to', () => {
    const hub = newHub();
    const handshake = startComputerHandshake('computer-2', [], '1');
    expect(answerHello(handshake.helloText, COMPUTER_ID, hub)).toEqual({ ok: false });
  });

  it('refuses a welcome signed for another hub origin', () => {
    const hub = newHub();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
    const answered = answerHello(handshake.helloText, COMPUTER_ID, {
      ...hub,
      origin: 'https://evil.example',
    });
    if (!answered.ok) throw new Error('unexpected');
    const result = finishComputerHandshake(handshake, JSON.stringify(answered.answer), {
      hubOrigin: ORIGIN,
      hubKey: hub.pinned,
      computerKey: newComputer().key,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a welcome replayed from an earlier connection', () => {
    const hub = newHub();
    const earlier = startComputerHandshake(COMPUTER_ID, [], '1');
    const answered = answerHello(earlier.helloText, COMPUTER_ID, hub);
    if (!answered.ok) throw new Error('unexpected');

    const now = startComputerHandshake(COMPUTER_ID, [], '1');
    const result = finishComputerHandshake(now, JSON.stringify(answered.answer), {
      hubOrigin: ORIGIN,
      hubKey: hub.pinned,
      computerKey: newComputer().key,
    });
    expect(result).toEqual({ ok: false, reason: 'unverified' });
  });

  it('refuses a hello altered in transit: the hub signs what it got, the computer checks what it sent', () => {
    const hub = newHub();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1', { min: 1, max: 3 });
    // A man in the middle downgrades the offer before the hub sees it.
    const altered = handshake.helloText.replace('"max":3', '"max":1');
    const answered = answerHello(altered, COMPUTER_ID, hub, { min: 1, max: 3 });
    if (!answered.ok) throw new Error('unexpected');
    const result = finishComputerHandshake(
      handshake,
      JSON.stringify(answered.answer),
      { hubOrigin: ORIGIN, hubKey: hub.pinned, computerKey: newComputer().key },
      { min: 1, max: 3 }
    );
    expect(result).toEqual({ ok: false, reason: 'unverified' });
  });

  it('refuses a welcome whose key was swapped while its signature was kept', () => {
    const hub = newHub();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
    const answered = answerHello(handshake.helloText, COMPUTER_ID, hub);
    if (!answered.ok || answered.answer.type !== 'welcome') throw new Error('unexpected');
    const swapped = {
      ...answered.answer,
      ephemeralKey: generateKeyPairSync('x25519')
        .publicKey.export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64url'),
    };
    const result = finishComputerHandshake(handshake, JSON.stringify(swapped), {
      hubOrigin: ORIGIN,
      hubKey: hub.pinned,
      computerKey: newComputer().key,
    });
    expect(result).toEqual({ ok: false, reason: 'unverified' });
  });

  it('refuses an unsigned or garbled answer', () => {
    const hub = newHub();
    for (const text of [
      '',
      'null',
      '{"type":"welcome"}',
      JSON.stringify({ type: 'refuse', versions: { min: 9, max: 9 } }),
    ]) {
      const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
      const result = finishComputerHandshake(handshake, text, {
        hubOrigin: ORIGIN,
        hubKey: hub.pinned,
        computerKey: newComputer().key,
      });
      expect(result.ok, text).toBe(false);
    }
  });

  it('can be finished only once, so no two channels share keys', () => {
    const hub = newHub();
    const computer = newComputer();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
    const answered = answerHello(handshake.helloText, COMPUTER_ID, hub);
    if (!answered.ok) throw new Error('unexpected');
    const pins = { hubOrigin: ORIGIN, hubKey: hub.pinned, computerKey: computer.key };
    expect(finishComputerHandshake(handshake, JSON.stringify(answered.answer), pins).ok).toBe(true);
    expect(finishComputerHandshake(handshake, JSON.stringify(answered.answer), pins)).toEqual({
      ok: false,
      reason: 'unverified',
    });
  });

  it('says "needs an update" only when the pinned hub signed the refusal', () => {
    const hub = newHub();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1', { min: 1, max: 1 });
    const answered = answerHello(handshake.helloText, COMPUTER_ID, hub, { min: 2, max: 3 });
    if (!answered.ok) throw new Error('unexpected');
    expect(answered.pending).toBeNull();
    const pins = { hubOrigin: ORIGIN, hubKey: hub.pinned, computerKey: newComputer().key };
    expect(
      finishComputerHandshake(handshake, JSON.stringify(answered.answer), pins, { min: 1, max: 1 })
    ).toEqual({ ok: false, reason: 'refused', versions: { min: 2, max: 3 } });

    // The same refusal checked against another hub's key is just unverified.
    const again = startComputerHandshake(COMPUTER_ID, [], '1', { min: 1, max: 1 });
    const theirs = answerHello(again.helloText, COMPUTER_ID, hub, { min: 2, max: 3 });
    if (!theirs.ok) throw new Error('unexpected');
    const other = newHub();
    expect(
      finishComputerHandshake(again, JSON.stringify(theirs.answer), {
        ...pins,
        hubKey: other.pinned,
      })
    ).toEqual({ ok: false, reason: 'unverified' });
  });

  it('refuses a signed welcome for a version this computer never offered', () => {
    const hub = newHub();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
    const ephemeralKey = randomBytes(32).toString('base64url');
    const transcript = relayWelcomeTranscript(
      { helloText: handshake.helloText, hubOrigin: ORIGIN },
      7,
      ephemeralKey
    );
    const signature = sign(null, transcript, hub.signingKey).toString('base64url');
    const answer = { type: 'welcome', version: 7, ephemeralKey, signature };

    expect(
      finishComputerHandshake(handshake, JSON.stringify(answer), {
        hubOrigin: ORIGIN,
        hubKey: hub.pinned,
        computerKey: newComputer().key,
      })
    ).toEqual({ ok: false, reason: 'bad-version' });
  });

  it('turns a low-order X25519 key into a failure on either end, never a throw', () => {
    const hub = newHub();
    const handshake = startComputerHandshake(COMPUTER_ID, [], '1');
    const zeroKey = Buffer.alloc(32).toString('base64url');
    const lowOrderHello = handshake.helloText.replace(handshake.hello.ephemeralKey, zeroKey);
    expect(answerHello(lowOrderHello, COMPUTER_ID, hub)).toEqual({ ok: false });

    // A hub answering with a low-order key, correctly signed.
    const transcript = relayWelcomeTranscript(
      { helloText: handshake.helloText, hubOrigin: ORIGIN },
      1,
      zeroKey
    );
    const answer = {
      type: 'welcome',
      version: 1,
      ephemeralKey: zeroKey,
      signature: sign(null, transcript, hub.signingKey).toString('base64url'),
    };
    expect(
      finishComputerHandshake(handshake, JSON.stringify(answer), {
        hubOrigin: ORIGIN,
        hubKey: hub.pinned,
        computerKey: newComputer().key,
      })
    ).toEqual({ ok: false, reason: 'unverified' });
  });
});

describe('the sealed channel', () => {
  it('seals an inner frame of exactly the shared byte limit, and refuses one byte more', () => {
    // Pins the protocol's constant to this channel's own arithmetic, so the two
    // can never drift apart.
    const { hub } = connect();
    expect(hub.seal('x'.repeat(SESSION_RELAY_MAX_INNER_FRAME_BYTES))).not.toBeNull();
    expect(hub.seal('x'.repeat(SESSION_RELAY_MAX_INNER_FRAME_BYTES + 1))).toBeNull();
  });

  it('keeps frames secret: the box never holds the text', () => {
    const { hub } = connect();
    const sealed = hub.seal(frame(42))!;
    expect(Buffer.from(sealed.box, 'base64url').toString('utf8')).not.toContain('viewers');
  });

  it('refuses a replayed frame, and is closed from then on', () => {
    const { computer, hub } = connect();
    const first = hub.seal(frame(1))!;
    expect(computer.open(first)).toBe(frame(1));

    expect(computer.open(first)).toBeNull();
    expect(computer.closed).toBe(true);
    expect(computer.open(hub.seal(frame(2))!)).toBeNull();
  });

  it('refuses frames out of order', () => {
    const { computer, hub } = connect();
    hub.seal(frame(1));
    expect(computer.open(hub.seal(frame(2))!)).toBeNull();
  });

  it('refuses an altered frame', () => {
    const { computer, hub } = connect();
    const sealed = hub.seal(frame(1))!;
    const box = Buffer.from(sealed.box, 'base64url');
    box[0] = box[0]! ^ 0xff;
    expect(computer.open({ ...sealed, box: box.toString('base64url') })).toBeNull();
  });

  it('refuses a frame whose box is not canonical base64url', () => {
    const { computer, hub } = connect();
    const sealed = hub.seal(frame(1))!;
    expect(computer.open({ ...sealed, box: `${sealed.box}A` })).toBeNull();
  });

  it('refuses a frame sent back to the side that sealed it', () => {
    const { hub } = connect();
    expect(hub.open(hub.seal(frame(1))!)).toBeNull();
  });

  it('refuses a frame from another connection to the same hub', () => {
    const hub = newHub();
    const a = connect(hub);
    const b = connect(hub);
    expect(b.computer.open(a.hub.seal(frame(1))!)).toBeNull();
  });

  it('declines an oversized frame without spending its sequence number', () => {
    const { computer, hub } = connect();
    const huge = JSON.stringify({ type: 'heartbeat', pad: 'x'.repeat(900_000) });
    expect(hub.seal(huge)).toBeNull();
    // The next frame still opens: no gap was left.
    expect(computer.open(hub.seal(frame(3))!)).toBe(frame(3));
  });
});
