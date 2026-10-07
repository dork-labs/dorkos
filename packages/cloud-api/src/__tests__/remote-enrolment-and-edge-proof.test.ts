/**
 * The managed remote-access rows a machine needs before it can be reached:
 * the enrolment request a person approves, the edge proof every managed
 * request carries, and the instance's own credential revoke.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ONE_TIME_CREDENTIAL_META,
  REMOTE_EDGE_PROOF_OVERLAP_SECONDS,
  REMOTE_EDGE_PROOF_RESERVED_HEADERS,
  REMOTE_ENROLMENT_MAX_WRONG_CODES,
  REMOTE_ENROLMENT_USER_CODE_ALPHABET,
  RemoteCredentialRevokeResponseSchema,
  RemoteCredentialSchema,
  RemoteEdgeProofSchema,
  RemoteEnrolmentApproveRequestSchema,
  RemoteEnrolmentRequestSchema,
  RemoteEnrolmentRequestStatusSchema,
  RemoteEnrolmentSchema,
  RemoteEnrolmentUserCodeSchema,
  V1_ROUTES,
  v1Path,
} from '../index.js';

describe('the enrolment user code', () => {
  it('accepts eight letters from the alphabet as XXXX-XXXX', () => {
    for (const code of ['BCDF-GHJK', 'ZZZZ-BBBB', 'MNPQ-RSTV']) {
      expect(RemoteEnrolmentUserCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('accepts every letter of the published alphabet, so the two cannot drift apart', () => {
    for (const letter of REMOTE_ENROLMENT_USER_CODE_ALPHABET) {
      const code = `${letter.repeat(4)}-${letter.repeat(4)}`;
      expect(RemoteEnrolmentUserCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('publishes an alphabet of twenty consonants with nothing that reads as a digit', () => {
    expect(REMOTE_ENROLMENT_USER_CODE_ALPHABET).toHaveLength(20);
    expect(new Set(REMOTE_ENROLMENT_USER_CODE_ALPHABET).size).toBe(20);
    expect(REMOTE_ENROLMENT_USER_CODE_ALPHABET).not.toMatch(/[AEIOUY0-9]/);
  });

  it('refuses anything but the canonical form', () => {
    for (const code of [
      'bcdf-ghjk', // lower case is for the page to normalise, not the wire
      'BCDFGHJK', // no hyphen
      'BCDF GHJK',
      'BCDF-GHJ', // too short
      'BCDF-GHJKL', // too long
      'BCDA-GHJK', // a vowel
      'BCD0-GHJK', // a digit
      'BCDO-GHJK', // O, which reads as zero
      ' BCDF-GHJK',
      '',
    ]) {
      expect(RemoteEnrolmentUserCodeSchema.safeParse(code).success, code).toBe(false);
    }
  });
});

describe('the enrolment request', () => {
  const request = {
    requestId: 'enrq_0001',
    userCode: 'BCDF-GHJK',
    approveUrl: 'https://cloud.example.invalid/remote/approve',
    expiresAt: '2026-09-15T12:15:00.000Z',
    pollAfterMs: 5000,
    consentVersion: '2026-09-01',
  };

  it('parses a request with a code, a page, an expiry, a poll delay and a consent version', () => {
    expect(RemoteEnrolmentRequestSchema.parse(request)).toEqual(request);
  });

  it('refuses an approval page that is not https', () => {
    for (const approveUrl of [
      'http://cloud.example.invalid/remote/approve',
      'javascript:alert(1)',
      '/remote/approve',
    ]) {
      expect(RemoteEnrolmentRequestSchema.safeParse({ ...request, approveUrl }).success).toBe(
        false
      );
    }
  });

  it('refuses a malformed code and an empty consent version', () => {
    expect(RemoteEnrolmentRequestSchema.safeParse({ ...request, userCode: 'abc' }).success).toBe(
      false
    );
    expect(RemoteEnrolmentRequestSchema.safeParse({ ...request, consentVersion: '' }).success).toBe(
      false
    );
  });
});

describe('where an enrolment request stands', () => {
  const enrolment = {
    enrolmentId: 'enr_0001',
    consentVersion: '2026-09-01',
    enrolledAt: '2026-09-15T12:03:00.000Z',
  };

  it('narrows on status, and only an approval carries the enrolment', () => {
    const approved = RemoteEnrolmentRequestStatusSchema.parse({
      status: 'approved',
      requestId: 'enrq_0001',
      enrolment,
    });
    expect(approved.status === 'approved' && approved.enrolment).toEqual(enrolment);

    const pending = RemoteEnrolmentRequestStatusSchema.parse({
      status: 'pending',
      requestId: 'enrq_0001',
      expiresAt: '2026-09-15T12:15:00.000Z',
      pollAfterMs: 5000,
    });
    expect(pending.status === 'pending' && pending.pollAfterMs).toBe(5000);

    for (const status of ['denied', 'expired'] as const) {
      expect(RemoteEnrolmentRequestStatusSchema.parse({ status, requestId: 'enrq_0001' })).toEqual({
        status,
        requestId: 'enrq_0001',
      });
    }
  });

  it('refuses an approval without its enrolment, and a pending read without its poll delay', () => {
    expect(
      RemoteEnrolmentRequestStatusSchema.safeParse({ status: 'approved', requestId: 'enrq_0001' })
        .success
    ).toBe(false);
    expect(
      RemoteEnrolmentRequestStatusSchema.safeParse({
        status: 'pending',
        requestId: 'enrq_0001',
        expiresAt: '2026-09-15T12:15:00.000Z',
      }).success
    ).toBe(false);
  });

  it('refuses a status it does not define, rather than guessing what it means', () => {
    expect(
      RemoteEnrolmentRequestStatusSchema.safeParse({ status: 'maybe', requestId: 'enrq_0001' })
        .success
    ).toBe(false);
  });

  it('does not let a denial carry an enrolment through a re-serialised relay', () => {
    const relayed = RemoteEnrolmentRequestStatusSchema.parse({
      status: 'denied',
      requestId: 'enrq_0001',
      enrolment,
    });
    expect(relayed).toEqual({ status: 'denied', requestId: 'enrq_0001' });
  });
});

describe('approving an enrolment request', () => {
  it('carries the code the person read on the machine', () => {
    expect(RemoteEnrolmentApproveRequestSchema.parse({ userCode: 'BCDF-GHJK' })).toEqual({
      userCode: 'BCDF-GHJK',
    });
  });

  it('refuses a body without a code, or with one in a non-canonical form', () => {
    expect(RemoteEnrolmentApproveRequestSchema.safeParse({}).success).toBe(false);
    expect(RemoteEnrolmentApproveRequestSchema.safeParse({ userCode: 'bcdfghjk' }).success).toBe(
      false
    );
  });
});

describe('the edge proof', () => {
  const proof = {
    header: 'x-example-edge-proof',
    secret: 'eps_0002_opaque_0000000000000000000000000000',
  };

  it('accepts a lower-case header name and a long opaque secret', () => {
    expect(RemoteEdgeProofSchema.parse(proof)).toEqual(proof);
  });

  it('refuses a header name that is not a plain lower-case token', () => {
    for (const header of [
      'X-Example-Edge-Proof',
      'x example',
      'x_example',
      '-x-example',
      'x-example-',
      'x--example',
      'x:example',
      '',
      'x'.repeat(65),
    ]) {
      expect(RemoteEdgeProofSchema.safeParse({ ...proof, header }).success, header).toBe(false);
    }
  });

  it('refuses a short secret, and one a header could not carry intact', () => {
    for (const secret of [
      's'.repeat(31),
      `${'s'.repeat(32)} `,
      `${'s'.repeat(32)}\n`,
      'é'.repeat(40),
    ]) {
      expect(RemoteEdgeProofSchema.safeParse({ ...proof, secret }).success, secret).toBe(false);
    }
    expect(RemoteEdgeProofSchema.safeParse({ ...proof, secret: 's'.repeat(32) }).success).toBe(
      true
    );
  });

  it('marks the secret as a one-time credential, so a relay can refuse to pass it on', () => {
    const meta = z.globalRegistry.get(RemoteEdgeProofSchema.shape.secret) as
      Record<string, unknown> | undefined;
    expect(meta?.[ONE_TIME_CREDENTIAL_META]).toBe(true);
  });

  it('publishes how long the previous secret stays acceptable after a replacement', () => {
    expect(REMOTE_EDGE_PROOF_OVERLAP_SECONDS).toBe(60);
  });

  describe('on a credential', () => {
    const credential = {
      issuanceId: 'iss_0001',
      credentialId: 'cred_0001',
      value: 'crv_0001_opaque',
      fingerprint: 'sha256:0',
      acl: ['tunnel:connect'],
    };

    it('travels with the credential it belongs to', () => {
      expect(RemoteCredentialSchema.parse({ ...credential, edgeProof: proof }).edgeProof).toEqual(
        proof
      );
    });

    it('is optional, so an answer from an older service still parses', () => {
      expect(RemoteCredentialSchema.parse(credential).edgeProof).toBeUndefined();
    });

    it('refuses a malformed proof rather than dropping it', () => {
      expect(
        RemoteCredentialSchema.safeParse({
          ...credential,
          edgeProof: { ...proof, header: 'Bad Header' },
        }).success
      ).toBe(false);
    });

    it('tells an instance not to open managed access without it', () => {
      expect(RemoteCredentialSchema.shape.edgeProof.description).toContain(
        'do not open managed access without it'
      );
    });
  });
});

describe('the routes', () => {
  it('publishes the request, its status, approve and deny, and the self-revoke', () => {
    expect(V1_ROUTES.remoteEnrolmentRequests).toBe('/v1/remote/enrolment/requests');
    expect(v1Path.remoteEnrolmentRequest('enrq_0001')).toBe(
      '/v1/remote/enrolment/requests/enrq_0001'
    );
    expect(v1Path.remoteEnrolmentRequestApprove('enrq_0001')).toBe(
      '/v1/remote/enrolment/requests/enrq_0001/approve'
    );
    expect(v1Path.remoteEnrolmentRequestDeny('enrq_0001')).toBe(
      '/v1/remote/enrolment/requests/enrq_0001/deny'
    );
    expect(V1_ROUTES.remoteCredentialsRevoke).toBe('/v1/remote/credentials/revoke');
  });

  it('refuses a request id that would move the call to another route', () => {
    expect(() => v1Path.remoteEnrolmentRequest('..')).toThrow(TypeError);
    expect(() => v1Path.remoteEnrolmentRequestApprove('.')).toThrow(TypeError);
    expect(v1Path.remoteEnrolmentRequestDeny('a/b')).toBe(
      '/v1/remote/enrolment/requests/a%2Fb/deny'
    );
  });

  it('answers a self-revoke with when it happened', () => {
    expect(
      RemoteCredentialRevokeResponseSchema.parse({ revokedAt: '2026-09-20T08:00:00.000Z' })
    ).toEqual({ revokedAt: '2026-09-20T08:00:00.000Z' });
  });
});

describe('the review follow-ups', () => {
  it('names the alphabet in the code`s description from the constant itself', () => {
    expect(RemoteEnrolmentUserCodeSchema.description).toContain(
      REMOTE_ENROLMENT_USER_CODE_ALPHABET
    );
  });

  it('ends a request after a fixed, published number of wrong codes', () => {
    expect(REMOTE_ENROLMENT_MAX_WRONG_CODES).toBe(5);
  });

  it('never asks for a poll sooner than one second', () => {
    const request = {
      requestId: 'enrq_0001',
      userCode: 'BCDF-GHJK',
      approveUrl: 'https://cloud.example.invalid/remote/approve',
      expiresAt: '2026-09-15T12:15:00.000Z',
      consentVersion: '2026-09-01',
    };
    expect(RemoteEnrolmentRequestSchema.safeParse({ ...request, pollAfterMs: 999 }).success).toBe(
      false
    );
    expect(RemoteEnrolmentRequestSchema.safeParse({ ...request, pollAfterMs: 1000 }).success).toBe(
      true
    );
    const pending = {
      status: 'pending',
      requestId: 'enrq_0001',
      expiresAt: '2026-09-15T12:15:00.000Z',
    };
    expect(
      RemoteEnrolmentRequestStatusSchema.safeParse({ ...pending, pollAfterMs: 0 }).success
    ).toBe(false);
  });

  it('refuses an enrolment with an empty consent version', () => {
    expect(
      RemoteEnrolmentSchema.safeParse({
        enrolmentId: 'enr_0001',
        consentVersion: '',
        enrolledAt: '2026-09-15T12:03:00.000Z',
      }).success
    ).toBe(false);
  });

  it('refuses every header HTTP, a proxy or a session already uses', () => {
    const secret = 's'.repeat(32);
    for (const header of [
      'authorization',
      'proxy-authorization',
      'cookie',
      'set-cookie',
      'host',
      'connection',
      'upgrade',
      'content-length',
      'transfer-encoding',
      'te',
      'forwarded',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      ':authority',
      ':path',
    ]) {
      expect(RemoteEdgeProofSchema.safeParse({ header, secret }).success, header).toBe(false);
    }
    for (const header of REMOTE_EDGE_PROOF_RESERVED_HEADERS) {
      expect(RemoteEdgeProofSchema.safeParse({ header, secret }).success, header).toBe(false);
    }
    // A name that merely contains a reserved word is still a usable name.
    for (const header of ['x-forwarded', 'x-host-proof', 'tea']) {
      expect(RemoteEdgeProofSchema.safeParse({ header, secret }).success, header).toBe(true);
    }
  });

  it('says the proof is required on every request over managed access', () => {
    const doc = RemoteEdgeProofSchema.description ?? '';
    expect(doc).toContain('Every request over managed access');
  });
});
