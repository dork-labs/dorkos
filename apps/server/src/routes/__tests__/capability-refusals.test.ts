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
    // Review round 1: no fault of the caller's lands on the 400 fallback.
    ['RESERVED_NAME', 'invalid_request', 400],
    ['DISCOVER_FAILED', 'internal_error', 500],
    ['SEND_FAILED', 'internal_error', 500],
    ['migration_failed', 'internal_error', 500],
    ['EXTENSION_TOOL_FAILED', 'internal_error', 500],
    ['RATE_LIMITED', 'rate_limited', 429],
    ['rate-limited', 'rate_limited', 429],
    ['request_rate_limited', 'rate_limited', 429],
    ['UNIDENTIFIED_CALLER', 'agent_identity_unverified', 401],
    ['UNIDENTIFIED_LAUNCHER', 'agent_identity_unverified', 401],
    ['PERSON_REQUIRED', 'person_only', 403],
    ['NEEDS_A_PERSON', 'person_only', 403],
    ['PEOPLE_ONLY', 'person_only', 403],
    ['OWNER_MUST_BE_PRESENT', 'operator_only', 403],
    ['owner_only', 'owner_only', 403],
    ['ADMIN_DENIED', 'forbidden', 403],
    ['NOT_ALLOWED', 'forbidden', 403],
    ['not_your_agent', 'forbidden', 403],
    ['IDENTITY_INACTIVE', 'forbidden', 403],
    ['DUPLICATE_NAME', 'conflict', 409],
    ['SLUG_TAKEN', 'slug_taken', 409],
    ['ROOM_FILE_EXISTS', 'room_file_exists', 409],
    ['NAME_TAKEN', 'conflict', 409],
    ['UNDO_CONFLICT', 'conflict', 409],
    ['BUSY', 'temporarily_unavailable', 503],
    ['DNS_TIMEOUT', 'temporarily_unavailable', 503],
    ['ATTACHMENT_TOO_LARGE', 'request_too_large', 413],
    ['UNSUPPORTED_MODEL', 'not_supported', 501],
    ['schedule_review_changed', 'precondition_failed', 412],
    ['preview_stale', 'precondition_failed', 412],
    ['request_already_resolved', 'already_resolved', 409],
    // A tool code that is already a shared code keeps it.
    ['AGENT_PAUSED', 'agent_paused', 409],
    ['ROOM_ARCHIVED', 'room_archived', 409],
    ['HANDLE_RESERVED', 'handle_reserved', 409],
    ['PROTECTED_FOLDER', 'protected_folder', 403],
    ['EXPIRED', 'expired', 410],
    ['NO_AGENT', 'invalid_request', 400],
    ['AGENT_CANNOT_DECIDE', 'forbidden', 403],
    ['TOO_MANY_FOLLOWERS', 'conflict', 409],
    ['handoff_ended', 'already_resolved', 409],
    ['ENOENT', 'internal_error', 500],
    ['outsider-held', 'forbidden', 403],
    ['NOT_ON_THIS_SURFACE', 'not_supported', 501],
    ['UNKNOWN_CALLER', 'agent_identity_unverified', 401],
    ['MESH_DISABLED', 'temporarily_unavailable', 503],
    ['ENABLE_NEEDS_YES', 'needs_approval', 403],
    ['SYSTEM_AGENT', 'forbidden', 403],
    ['LAUNCH_CAP_FULL', 'conflict', 409],
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

  it('names the reserved-name rule without echoing the name sent', () => {
    const body = toolRefusalProblem({
      error: 'dorkos is one of DorkOS’s own names.',
      code: 'RESERVED_NAME',
    });
    expect(body.detail).toBe('That is one of DorkOS’s own names. Pick another.');
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
