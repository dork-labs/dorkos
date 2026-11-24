/**
 * What a capability's refusal answers over HTTP: a problem from a fixed table,
 * whatever the refusal itself said (ADR 261123-170831).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { isProblem } from '@dorkos/shared/problem';

import { gateRefusalProblem, toolRefusalProblem } from '../capability-refusals.js';

describe('toolRefusalProblem', () => {
  it.each([
    ['SIGNIN_NO_APP_REGISTRATION', 'signin_no_app_registration', 409],
    ['SIGNIN_NO_SIGNIN_SUPPORT', 'signin_no_signin_support', 409],
    ['SIGNIN_UNREACHABLE', 'signin_unreachable', 502],
    ['AGENT_IDENTITY_UNVERIFIED', 'agent_identity_unverified', 401],
    ['CANNOT_RESUME_SELF', 'forbidden', 403],
    ['OPERATOR_ONLY', 'operator_only', 403],
    ['outside_turn', 'outside_turn', 403],
    ['SPEND_LIMIT', 'spend_limit_reached', 409],
    ['AGENT_NOT_FOUND', 'not_found', 404],
    ['NOT_FOUND', 'not_found', 404],
    ['UNKNOWN_ACTION', 'not_found', 404],
    ['CONNECTOR_PRINCIPAL_CHANGED', 'precondition_failed', 412],
    ['STALE_QUEUE', 'precondition_failed', 412],
    ['NOT_READY', 'temporarily_unavailable', 503],
    ['CONNECTOR_REQUEST_UNAVAILABLE', 'temporarily_unavailable', 503],
    ['CONNECTOR_GRANT_REQUIRED', 'forbidden', 403],
    ['CONNECTOR_PREFLIGHT_REQUIRED', 'needs_approval', 403],
    ['CONNECTOR_TARGET_NOT_FOUND', 'not_found', 404],
    ['already_ended', 'already_resolved', 409],
    ['MISSING_FILTER', 'invalid_request', 400],
  ] as const)('answers %s as %s (%i)', (toolCode, code, status) => {
    const body = toolRefusalProblem({ error: 'whatever the handler said', code: toolCode });
    expect(isProblem(body)).toBe(true);
    expect(body).toMatchObject({ code, status });
    expect(body.detail).toBeTruthy();
  });

  it('never copies the handler’s own words, which may be an exception’s text', () => {
    const body = toolRefusalProblem({
      error: 'ECONNREFUSED 10.0.0.4:8443 at /Users/someone/.dork/agents/x/agent.json',
      code: 'SIGNIN_UNREACHABLE',
      detail: 'HTTP 404: raw upstream body',
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('raw upstream body');
  });

  it('answers a payload with no code, or no object at all, as invalid_request', () => {
    expect(toolRefusalProblem({ error: 'x' }).code).toBe('invalid_request');
    expect(toolRefusalProblem('a bare string').code).toBe('invalid_request');
    expect(toolRefusalProblem(undefined).code).toBe('invalid_request');
  });
});

describe('gateRefusalProblem', () => {
  const base = {
    status: 'denied',
    capabilityId: 'agent.delete',
    capabilityTitle: 'Delete an agent',
    tier: 'destructive',
    approvable: false,
    message: 'Refused because of "Delete an agent".',
  } as const;

  it('answers a person’s no as declined, carrying the approval it refers to', () => {
    const body = gateRefusalProblem({ ...base, reason: 'operator_denied', approvalId: 'ap-1' });
    expect(body).toMatchObject({
      code: 'declined',
      status: 403,
      capabilityId: 'agent.delete',
      tier: 'destructive',
      approvable: false,
      approvalId: 'ap-1',
    });
    expect(body).not.toHaveProperty('reason');
  });

  it.each([
    ['recently_denied', 'declined'],
    ['request_pending', 'needs_approval'],
    ['permission_blocked', 'forbidden'],
    ['enforcement_unavailable', 'forbidden'],
    ['input_not_bindable', 'forbidden'],
    ['request_limit', 'forbidden'],
  ] as const)('answers %s as %s, always a 403', (reason, code) => {
    const body = gateRefusalProblem({ ...base, reason });
    expect(body).toMatchObject({ code, status: 403 });
    expect(body.detail).not.toContain('Delete an agent');
  });
});
