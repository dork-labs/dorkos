/**
 * @vitest-environment node
 *
 * The owner's passkeys (`factors/owner-passkeys.ts`, DOR-3647, DOR-4744),
 * driven by a software authenticator: no browser, no platform authenticator.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import { SoftAuthenticator } from '@dorkos/test-utils/soft-authenticator';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import { initAuth } from '../index.js';
import {
  finishAddingPasskey,
  finishPasskeyCheck,
  passkeyOrigins,
  resetPasskeyChallengesForTests,
  startAddingPasskey,
  startPasskeyCheck,
} from '../factors/owner-passkeys.js';
import { confirmedFactors } from '../factors/owner-factors.js';
import { initConfigManager } from '../../config-manager.js';

const OWNER = 'owner-1';
const SESSION = 'session-at-desk';

let tmpDir: string;
let db: Db;
let origin: string;
let rpId: string;

/** A registration response from the soft authenticator, as the browser returns it. */
function registrationOf(
  device: SoftAuthenticator,
  challenge: string,
  overrides: Parameters<SoftAuthenticator['attest']>[0] extends infer T
    ? Partial<Omit<T & object, 'challenge'>>
    : never = {}
): RegistrationResponseJSON {
  const made = device.attest({ challenge, ...overrides });
  return {
    id: made.credentialId,
    rawId: made.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: { clientDataJSON: made.clientDataJSON, attestationObject: made.attestationObject },
  };
}

/** An assertion from the soft authenticator, as the browser returns it. */
function assertionOf(
  device: SoftAuthenticator,
  options: Parameters<SoftAuthenticator['assert']>[0]
): AuthenticationResponseJSON {
  const signed = device.assert(options);
  return {
    id: signed.credentialId,
    rawId: signed.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
      signature: signed.signature,
      ...(signed.userHandle ? { userHandle: signed.userHandle } : {}),
    },
  };
}

/** Add a passkey on `origin` and return its authenticator. */
async function addOne(): Promise<SoftAuthenticator> {
  const device = new SoftAuthenticator({ rpId, origin, userHandle: 'b3duZXI' });
  const options = await startAddingPasskey({
    userId: OWNER,
    userName: 'owner',
    sessionId: SESSION,
    origin,
    label: 'Test key',
  });
  if (typeof options === 'string') throw new Error(options);
  const added = await finishAddingPasskey({
    userId: OWNER,
    sessionId: SESSION,
    response: registrationOf(device, options.challenge),
  });
  expect(added).toMatchObject({ host: rpId });
  return device;
}

const SIGN_IN = { kind: 'sign-in', userId: OWNER } as const;
const CONFIRM = {
  kind: 'confirm',
  userId: OWNER,
  sessionId: SESSION,
  action: 'wifi-sign-in-approve:abc',
} as const;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-owner-passkeys-'));
  initConfigManager(tmpDir);
  db = createDb(path.join(tmpDir, 'auth.db'));
  runMigrations(db);
  initAuth(db, tmpDir);
  db.insert(user)
    .values({ id: OWNER, name: 'Owner', email: 'owner@dork.test', updatedAt: new Date() })
    .run();
  origin = passkeyOrigins()[0]!;
  rpId = new URL(origin).hostname;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetPasskeyChallengesForTests();
});

describe('adding a passkey', () => {
  it('stores one made with the person verified, on one of our own origins', async () => {
    await addOne();
    expect(confirmedFactors(OWNER, 'passkey').some((row) => row.rpId === rpId)).toBe(true);
  });

  it('refuses an origin that is not one of ours', async () => {
    const refused = await startAddingPasskey({
      userId: OWNER,
      userName: 'owner',
      sessionId: SESSION,
      origin: 'https://elsewhere.example',
      label: 'x',
    });
    expect(refused).toBe('origin');
  });

  it('refuses one made without verifying the person', async () => {
    const device = new SoftAuthenticator({ rpId, origin, userHandle: 'b3duZXI' });
    const options = await startAddingPasskey({
      userId: OWNER,
      userName: 'owner',
      sessionId: SESSION,
      origin,
      label: 'x',
    });
    if (typeof options === 'string') throw new Error(options);
    const result = await finishAddingPasskey({
      userId: OWNER,
      sessionId: SESSION,
      response: registrationOf(device, options.challenge, { userVerified: false }),
    });
    expect(result).toBe('not-verified');
  });

  it('refuses a response signed for another origin or for another sign-in', async () => {
    const device = new SoftAuthenticator({ rpId, origin, userHandle: 'b3duZXI' });
    const start = () =>
      startAddingPasskey({ userId: OWNER, userName: 'o', sessionId: SESSION, origin, label: 'x' });
    const first = await start();
    if (typeof first === 'string') throw new Error(first);
    expect(
      await finishAddingPasskey({
        userId: OWNER,
        sessionId: SESSION,
        response: registrationOf(device, first.challenge, { origin: 'https://elsewhere.example' }),
      })
    ).toBe('not-verified');
    const second = await start();
    if (typeof second === 'string') throw new Error(second);
    expect(
      await finishAddingPasskey({
        userId: OWNER,
        sessionId: 'another-sign-in',
        response: registrationOf(device, second.challenge),
      })
    ).toBe('challenge');
  });
});

describe('checking a passkey', () => {
  it('signs the owner in with a passkey made for this origin', async () => {
    const device = await addOne();
    const options = await startPasskeyCheck(SIGN_IN, origin);
    if (typeof options === 'string') throw new Error(options);
    const result = await finishPasskeyCheck(
      SIGN_IN,
      assertionOf(device, { challenge: options.challenge })
    );
    expect(result).toMatchObject({ userId: OWNER });
  });

  it('takes a challenge on first use', async () => {
    const device = await addOne();
    const options = await startPasskeyCheck(SIGN_IN, origin);
    if (typeof options === 'string') throw new Error(options);
    const response = assertionOf(device, { challenge: options.challenge });
    expect(await finishPasskeyCheck(SIGN_IN, response)).toMatchObject({ userId: OWNER });
    expect(await finishPasskeyCheck(SIGN_IN, response)).toBe('challenge');
  });

  it('a check made for one action never confirms another', async () => {
    const device = await addOne();
    const options = await startPasskeyCheck(CONFIRM, origin);
    if (typeof options === 'string') throw new Error(options);
    const response = assertionOf(device, { challenge: options.challenge });
    expect(
      await finishPasskeyCheck({ ...CONFIRM, action: 'wifi-sign-in-approve:other' }, response)
    ).toBe('challenge');
  });

  it('a sign-in check never confirms an action', async () => {
    const device = await addOne();
    const options = await startPasskeyCheck(SIGN_IN, origin);
    if (typeof options === 'string') throw new Error(options);
    expect(
      await finishPasskeyCheck(CONFIRM, assertionOf(device, { challenge: options.challenge }))
    ).toBe('challenge');
  });

  it('refuses a check without the person verified', async () => {
    const device = await addOne();
    const options = await startPasskeyCheck(SIGN_IN, origin);
    if (typeof options === 'string') throw new Error(options);
    expect(
      await finishPasskeyCheck(
        SIGN_IN,
        assertionOf(device, { challenge: options.challenge, userVerified: false })
      )
    ).toBe('not-verified');
  });

  it('refuses a signature counter that goes back', async () => {
    const device = await addOne();
    const once = await startPasskeyCheck(SIGN_IN, origin);
    if (typeof once === 'string') throw new Error(once);
    await finishPasskeyCheck(
      SIGN_IN,
      assertionOf(device, { challenge: once.challenge, signCount: 5 })
    );
    const again = await startPasskeyCheck(SIGN_IN, origin);
    if (typeof again === 'string') throw new Error(again);
    expect(
      await finishPasskeyCheck(
        SIGN_IN,
        assertionOf(device, { challenge: again.challenge, signCount: 3 })
      )
    ).toBe('counter');
  });

  it('refuses an assertion signed for an origin that is not the one the check began on', async () => {
    const device = await addOne();
    const options = await startPasskeyCheck(SIGN_IN, origin);
    if (typeof options === 'string') throw new Error(options);
    expect(
      await finishPasskeyCheck(
        SIGN_IN,
        assertionOf(device, {
          challenge: options.challenge,
          origin: 'https://elsewhere.example',
        })
      )
    ).toBe('not-verified');
  });

  it('refuses a check started on an origin that is not one of ours', async () => {
    await addOne();
    expect(await startPasskeyCheck(SIGN_IN, 'https://elsewhere.example')).toBe('origin');
  });
});
