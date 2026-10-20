/**
 * @vitest-environment node
 *
 * The enrolment on its own: the return page's host from the socket the start
 * arrived on, this computer's own failures told apart from the owner's, and
 * this module's algorithm check, reached behind a widened library list.
 */
import { describe, expect, it } from 'vitest';
import { SoftAuthenticator } from '@dorkos/test-utils/soft-authenticator';
import { decodeStepUpBase64url, decodeStepUpStatement } from '@dork-labs/cloud-api';
import {
  PasskeyEnrolment,
  loopbackReturnHost,
  type StartEnrolmentInput,
} from '../passkey-enrolment.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');

const INPUT: StartEnrolmentInput = {
  computerId: 'computer-1',
  computerName: 'Studio Mac',
  accountId: 'acct_owner',
  label: 'MacBook passkey',
  pinned: null,
  hubOrigin: 'https://me.dorkos.test',
  issuer: undefined,
  localAddress: '127.0.0.1',
  port: 4242,
};

const PIN = { computerId: 'computer-1', accountId: 'acct_owner' };

describe('loopbackReturnHost', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::1', 'localhost'],
    ['10.0.0.2', undefined],
    ['::ffff:192.168.1.4', undefined],
    [undefined, undefined],
  ])('%s → %s', (address, host) => {
    expect(loopbackReturnHost(address)).toBe(host);
  });
});

describe('PasskeyEnrolment.start', () => {
  it('names the address the start arrived on', async () => {
    const started = await new PasskeyEnrolment(() => NOW).start({ ...INPUT, localAddress: '::1' });
    if (typeof started === 'string') throw new Error(started);
    const statement = decodeStepUpStatement(decodeStepUpBase64url(started.statement));
    expect(statement).toMatchObject({ returnTo: 'http://localhost:4242/relay-passkey' });
  });

  it.each<[string, Partial<StartEnrolmentInput>]>([
    ['no port', { port: undefined }],
    ['an address off loopback', { localAddress: '10.0.0.2' }],
    ['a computer name the statement cannot carry', { computerName: 'Studio Mac ' }],
  ])('is this computer’s failure, not a bad origin, with %s', async (_, over) => {
    const enrolment = new PasskeyEnrolment(() => NOW);
    expect(await enrolment.start({ ...INPUT, ...over })).toBe('cannot-start');
    expect(enrolment.open).toBe(false);
  });
});

describe('PasskeyEnrolment.finish', () => {
  it('refuses a key naming another algorithm even when the library would take it', async () => {
    // The library is told to accept RS1 too, so only this module's own check stands.
    const enrolment = new PasskeyEnrolment(() => NOW, [-7, -8, -257, -65535]);
    const started = await enrolment.start(INPUT);
    if (typeof started === 'string') throw new Error(started);
    const statement = decodeStepUpStatement(decodeStepUpBase64url(started.statement));
    if (statement.t !== 'dorkos.relay.passkey-enrol.v1') throw new Error('not an enrol statement');
    const passkey = new SoftAuthenticator({
      rpId: statement.rpId,
      origin: statement.origin,
      userHandle: statement.userHandle,
    });
    const attestation = passkey.attest({ challenge: started.challenge, claimedAlg: -65535 });
    const result = await enrolment.finish(
      {
        statement: started.statement,
        attestation: {
          id: attestation.credentialId,
          rawId: attestation.credentialId,
          type: 'public-key',
          response: {
            clientDataJSON: attestation.clientDataJSON,
            attestationObject: attestation.attestationObject,
          },
          clientExtensionResults: {},
        },
      },
      null,
      PIN
    );
    expect(result).toEqual({ ok: false, refusal: 'algorithm' });
  });
});

describe('a DorkOS Cloud issuer', () => {
  it.each(['https://cloud.dorkos.ai', 'https://cloud.dorkos.ai.', 'https://dorkos.ai/'])(
    '%s allows only the DorkOS approve page',
    async (issuer) => {
      const enrolment = new PasskeyEnrolment(() => NOW);
      expect(await enrolment.start({ ...INPUT, issuer, origin: 'https://hub.example.test' })).toBe(
        'cloud-only'
      );
    }
  );
});
