/**
 * `POST /v1/account/deletion`: asking to delete the account.
 *
 * The fixtures test proves the examples parse. This file pins what the app
 * relies on: the route's path, that the request carries nothing a caller could
 * use to skip the emailed confirmation, and that the answer says where the link
 * went and until when, never that anything was deleted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as contract from '../index.js';
import { V1_ROUTES } from '../routes.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/**
 * Reads one conformance fixture.
 *
 * @param rel - The fixture path relative to `fixtures/v1`.
 */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

describe('asking to delete the account', () => {
  const response = contract.AccountDeletionResponseSchema;

  it('lives beside the export, under the account', () => {
    expect(V1_ROUTES.accountDeletion).toBe('/v1/account/deletion');
  });

  it('takes an empty body, and drops anything that claims to confirm or skip the email', () => {
    const request = contract.AccountDeletionRequestSchema;
    expect(request.parse({})).toEqual({});
    // Not strict, like every object here, so an unknown field is dropped by
    // parse rather than refused. What matters is that nothing survives into a
    // shape a service could read as "already confirmed".
    expect(request.parse({ confirmed: true, skipEmail: true, immediate: true })).toEqual({});
  });

  it('says where the link went and until when', () => {
    const parsed = response.parse(fixture('session/account-deletion.json'));
    expect(parsed.confirmationSentTo).toBe('p•••@example.invalid');
    expect(parsed.confirmBy).toBe('2026-09-16T12:00:00.000Z');
  });

  it('allows a link with no deadline, but never a missing answer about it', () => {
    const base = fixture('session/account-deletion.json');
    expect(response.safeParse({ ...base, confirmBy: null }).success).toBe(true);
    const { confirmBy: _dropped, ...withoutDeadline } = base;
    expect(response.safeParse(withoutDeadline).success).toBe(false);
  });

  it('needs somewhere the link went: an empty address is not an answer', () => {
    const base = fixture('session/account-deletion.json');
    expect(response.safeParse({ ...base, confirmationSentTo: '' }).success).toBe(false);
    const { confirmationSentTo: _dropped, ...withoutAddress } = base;
    expect(response.safeParse(withoutAddress).success).toBe(false);
  });

  it('carries no field that could say the account is already gone', () => {
    expect(Object.keys(response.shape).sort()).toEqual([
      'confirmBy',
      'confirmationSentTo',
      'requestedAt',
    ]);
  });

  it('refuses with the shared envelope, its words and its link intact', () => {
    const refusal = contract.ProblemSchema.parse(fixture('problem/account-deletion-conflict.json'));
    expect(refusal.code).toBe('conflict');
    expect(refusal.status).toBe(409);
    expect(refusal.actionUrl).toBe('https://account.example.invalid/team');
  });
});
