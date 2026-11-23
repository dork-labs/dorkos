/** Private Windows owner-side transcript for the native attempt exchange. */
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 1;
const CHALLENGE = 1;
const RESPONSE = 2;
const ACCEPTED = 3;
const ROLE = { main: 1, scope: 2 };
const NONCE_OFFSET = 36;
const TAG_OFFSET = 68;
export const OWNER_FRAME_BYTES = 100;

function signature(capability, frame) {
  return createHmac('sha256', capability).update(frame.subarray(0, TAG_OFFSET)).digest();
}

/** Own a copy of one role capability until the second acknowledgement or disposal. */
export function createOwnerAttemptPeer({ scopeId, attemptId, role, capability }) {
  if (
    typeof scopeId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(scopeId) ||
    typeof attemptId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(attemptId) ||
    (role !== 'main' && role !== 'scope') ||
    !Buffer.isBuffer(capability) ||
    capability.length !== 32
  ) {
    throw new TypeError('Invalid Windows owner attempt binding');
  }
  const key = Buffer.from(capability);
  const binding = Buffer.from(scopeId + attemptId, 'hex');
  let phase = 1;
  let awaiting = CHALLENGE;
  let nonce;
  let priorNonce;

  function dispose() {
    phase = 0;
    key.fill(0);
  }

  function invalid() {
    dispose();
    throw new Error('Windows owner frame did not match the active attempt');
  }

  return {
    accept(frame) {
      if (
        phase === 0 ||
        !Buffer.isBuffer(frame) ||
        frame.length !== OWNER_FRAME_BYTES ||
        frame[0] !== VERSION ||
        frame[1] !== phase ||
        frame[2] !== ROLE[role] ||
        frame[3] !== awaiting ||
        !frame.subarray(4, NONCE_OFFSET).equals(binding) ||
        !timingSafeEqual(signature(key, frame), frame.subarray(TAG_OFFSET))
      ) {
        invalid();
      }

      const incomingNonce = frame.subarray(NONCE_OFFSET, TAG_OFFSET);
      if (awaiting === CHALLENGE) {
        if (priorNonce?.equals(incomingNonce)) invalid();
        nonce = Buffer.from(incomingNonce);
        const response = Buffer.from(frame);
        response[3] = RESPONSE;
        signature(key, response).copy(response, TAG_OFFSET);
        awaiting = ACCEPTED;
        return { kind: 'response', frame: response };
      }

      if (!nonce.equals(incomingNonce)) invalid();
      priorNonce = nonce;
      nonce = undefined;
      if (phase === 1) {
        phase = 2;
        awaiting = CHALLENGE;
        return { kind: 'admitted' };
      }

      dispose();
      return { kind: 'confirmed' };
    },
    dispose,
  };
}
