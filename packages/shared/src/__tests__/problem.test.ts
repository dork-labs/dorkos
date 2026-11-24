import { describe, expect, it } from 'vitest';
import { ProblemCodeSchema as CloudProblemCodeSchema } from '@dork-labs/cloud-api';
import {
  PROBLEM_CODE_LIST,
  PROBLEM_CODE_PATTERN,
  PROBLEM_CODES,
  ProblemCodeSchema,
  ProblemSchema,
  isProblem,
  problemType,
  readErrorBody,
} from '../problem.js';

describe('PROBLEM_CODE_LIST', () => {
  it('names each code once', () => {
    const codes = PROBLEM_CODE_LIST.map((entry) => entry.code);
    const repeated = codes.filter((code, index) => codes.indexOf(code) !== index);
    expect(repeated).toEqual([]);
  });

  it('spells every code lower_snake, as the Cloud contract does', () => {
    for (const { code } of PROBLEM_CODE_LIST) expect(code).toMatch(PROBLEM_CODE_PATTERN);
  });

  it('gives every code an error status and a title', () => {
    for (const { status, title } of PROBLEM_CODE_LIST) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
      expect(title.trim()).not.toBe('');
    }
  });

  it.each([
    ['method_not_allowed', 405],
    ['declined', 403],
    ['upstream_unavailable', 502],
    ['outside_turn', 403],
    ['precondition_failed', 412],
    ['already_resolved', 409],
    ['needs_review', 409],
    ['not_running', 409],
    ['no_agent', 409],
    ['room_not_allowed', 403],
    ['caller_token_invalid', 403],
    ['secret_left', 500],
    ['signing_in', 409],
    ['history_refused', 409],
    ['signin_no_app_registration', 409],
    ['signin_no_signin_support', 409],
    ['signin_unreachable', 502],
    ['spend_limit_reached', 409],
  ] as const)('sends %s with status %i by default', (code, status) => {
    expect(PROBLEM_CODES[code].status).toBe(status);
  });

  it('indexes every code, and the schema accepts exactly the list', () => {
    expect(Object.keys(PROBLEM_CODES).sort()).toEqual(
      PROBLEM_CODE_LIST.map((entry) => entry.code).sort()
    );
    expect(ProblemCodeSchema.options.length).toBe(PROBLEM_CODE_LIST.length);
    expect(ProblemCodeSchema.safeParse('NOT_FOUND').success).toBe(false);
  });

  it('holds the codes chats, agents, rooms and work branch on, at their statuses', () => {
    const expected: ReadonlyArray<readonly [string, number]> = [
      ['agent_paused', 409],
      ['room_session_moved', 409],
      ['desk_not_own', 409],
      ['protected_folder', 403],
      ['queued_message_not_found', 404],
      ['queued_message_launching', 409],
      ['task_not_running', 409],
      ['not_supported', 501],
      ['account_not_allowed_here', 409],
      ['expired', 410],
      ['room_not_found', 404],
      ['room_archived', 409],
      ['slug_taken', 409],
      ['handle_taken', 409],
      ['handle_reserved', 409],
      ['handle_lookalike', 409],
      ['invalid_handle', 400],
      ['identity_not_external', 400],
      ['chat_already_bound', 409],
      ['reserved_sender', 403],
      ['reserved_subject', 403],
      ['room_conversation', 403],
      ['broadcast_not_bridgeable', 400],
      ['chat_type_unknown', 400],
      ['chat_route_paused', 409],
      ['invalid_signature', 401],
      ['connection_id_taken', 409],
      ['connection_saved_not_started', 502],
      ['cloud_link_required', 401],
      ['cloud_unavailable', 503],
      ['cloud_refused', 502],
      ['app_not_set_up', 404],
      ['app_not_supported', 422],
      ['account_cleanup_pending', 409],
      ['still_connected', 409],
      ['other_agent_chat', 409],
      ['app_off_in_chat', 409],
      ['destination_unavailable', 409],
      ['review_resolving', 409],
      ['updates_unavailable', 503],
      ['updates_changed', 412],
      ['invalid_filter', 400],
      ['request_open_elsewhere', 409],
      ['avatar_missing', 400],
      ['avatar_type_unsupported', 415],
      ['attachment_not_found', 404],
      ['room_repo_exists', 409],
      ['room_repos_disabled', 409],
      ['room_repo_git_unavailable', 409],
      ['room_has_no_repo', 409],
      ['room_file_path_invalid', 400],
      ['room_file_not_found', 404],
      ['room_file_not_readable', 400],
      ['room_file_not_text', 400],
      ['room_file_exists', 409],
      ['room_upload_too_many_files', 400],
      ['file_changed', 409],
      ['main_checkout_dirty', 409],
      ['room_repo_config_unsafe', 409],
      ['file_too_large', 409],
      ['repo_cap_exceeded', 409],
      ['merge_in_flight', 429],
      ['declined', 403],
      ['reports_to_cycle', 400],
      ['terminal_limit', 429],
      ['too_large', 413],
      ['not_a_file', 400],
      ['binary_file', 415],
      ['not_a_folder', 400],
      ['already_exists', 409],
      ['folder_not_empty', 409],
      ['copy_into_self', 400],
      ['working_folder_root', 400],
      ['range_not_satisfiable', 416],
      ['save_not_applied', 412],
      ['wrong_password', 403],
      ['too_many_tries', 403],
      ['password_too_short', 409],
      ['no_password', 409],
      ['no_owner', 409],
      ['insecure_connection', 403],
      ['extension_risk', 409],
      ['stale_sign_in', 409],
      ['stale_page', 409],
      ['passkey_needed', 409],
      ['passkey_on_other_address', 409],
      ['passkey_refused', 401],
      ['auth_required_for_exposure', 409],
      ['lan_access_unsupported', 409],
      ['set_by_environment', 409],
      ['remote_access_unavailable', 409],
      ['remote_access_already_set_up', 409],
      ['remote_access_not_set_up', 409],
      ['held_by_another_browser', 403],
      ['signin_no_retry', 409],
      ['sign_in_needs_https', 409],
      ['schedule_package_owned', 409],
      ['past_due', 400],
    ];
    for (const [code, status] of expected) {
      expect(PROBLEM_CODES[code as keyof typeof PROBLEM_CODES]?.status, code).toBe(status);
    }
  });
});

describe('the space, account, tunnel, hub and computer codes', () => {
  it('holds each at its status (DOR-4979)', () => {
    const expected: ReadonlyArray<readonly [string, number]> = [
      ['owner_changed', 412],
      ['pairing_busy', 409],
      ['reconnect_required', 409],
      ['space_choice_required', 409],
      ['space_name_not_found', 404],
      ['space_server_outdated', 426],
      ['space_deleted', 410],
      ['space_taken_down', 423],
      ['space_suspended', 423],
      ['space_on_hold', 423],
      ['space_read_only', 423],
      ['space_not_open', 409],
      ['space_muted', 403],
      ['space_slow_mode', 429],
      ['space_rules_not_accepted', 403],
      ['space_limit_reached', 409],
      ['space_unsupported', 409],
      ['space_name_taken', 409],
      ['report_not_allowed', 409],
      ['reply_on_top_level_only', 409],
      ['move_pending', 409],
      ['length_required', 411],
      ['computer_offline', 503],
      ['computer_timed_out', 504],
      ['agent_not_taking_dms', 409],
      ['cloud_not_linked', 409],
      ['hub_linked_by_cloud', 409],
      ['runtime_busy', 409],
      ['credits_off', 409],
      ['disk_full', 507],
      ['disk_space_unknown', 507],
      ['auth_required_for_exposure', 409],
      ['tunnel_running', 409],
      ['tunnel_token_missing', 400],
      ['tunnel_port_mismatch', 409],
      ['computer_waking', 503],
      ['computer_refused', 502],
      ['needs_update', 501],
      ['link_code_refused', 401],
      ['already_linked', 409],
      ['computer_limit_reached', 409],
      ['not_acceptable', 406],
      ['computer_unsupported', 400],
      ['computer_disabled', 400],
      ['computer_sign_in_required', 400],
      ['computer_control_lost', 409],
      ['computer_cleanup_uncertain', 409],
      ['computer_setup_failed', 503],
    ];
    for (const [code, status] of expected) {
      expect(PROBLEM_CODES[code as keyof typeof PROBLEM_CODES]?.status, code).toBe(status);
    }
  });
});

describe('agreement with the DorkOS Cloud contract', () => {
  it('spells every code both lists hold the same way', () => {
    const cloud = new Set<string>(CloudProblemCodeSchema.options);
    const ours = PROBLEM_CODE_LIST.map((entry) => entry.code);
    const shared = ours.filter((code) => cloud.has(code));
    // A code that differs only in case or separators is a misspelling of a shared one.
    const fold = (code: string) => code.toLowerCase().replace(/[^a-z]/g, '');
    const cloudFolded = new Map([...cloud].map((code) => [fold(code), code]));
    const misspelled = ours.filter((code) => !cloud.has(code) && cloudFolded.has(fold(code)));
    expect(misspelled).toEqual([]);
    expect(shared).toEqual(
      expect.arrayContaining(['unauthenticated', 'forbidden', 'malformed_request', 'not_found'])
    );
  });

  it('reads a Cloud-shaped problem, which has no type', () => {
    expect(
      isProblem({
        code: 'rate_limited',
        status: 429,
        title: 'Slow down.',
        retryAfterMs: 1000,
        requiredPlanDisplayName: 'Any plan',
      })
    ).toBe(true);
  });
});

describe('ProblemSchema', () => {
  const minimal = {
    type: problemType('not_found'),
    title: 'Not found.',
    status: 404,
    code: 'not_found',
  };

  it('accepts a minimal problem and a full one', () => {
    expect(isProblem(minimal)).toBe(true);
    expect(
      isProblem({
        ...minimal,
        code: 'malformed_request',
        status: 400,
        detail: 'The name is missing.',
        instance: 'req_1',
        retryAfterMs: 0,
        issues: { formErrors: [], fieldErrors: { name: ['Required'] } },
      })
    ).toBe(true);
  });

  it('reads a code only the Cloud contract holds', () => {
    for (const code of ['balance_exhausted', 'invalid_token', 'entitlement_required']) {
      expect(CloudProblemCodeSchema.safeParse(code).success).toBe(true);
      expect(ProblemCodeSchema.safeParse(code).success).toBe(false);
      expect(isProblem({ code, status: 402, title: 'Refused.' })).toBe(true);
    }
  });

  it('refuses a SCREAMING_CASE code', () => {
    expect(isProblem({ ...minimal, code: 'NOT_FOUND' })).toBe(false);
  });

  it('refuses a body in the old `{ error, code }` shape', () => {
    expect(isProblem({ error: 'Not found', code: 'NOT_FOUND' })).toBe(false);
  });

  it('refuses a success status', () => {
    expect(ProblemSchema.safeParse({ ...minimal, status: 200 }).success).toBe(false);
  });
});

describe('readErrorBody', () => {
  it('reads a problem: detail first, then title', () => {
    expect(
      readErrorBody(
        {
          type: problemType('request_too_large'),
          title: 'The request is too large.',
          status: 413,
          code: 'request_too_large',
          detail: 'That file is over 1 MB.',
        },
        'HTTP 413'
      )
    ).toEqual({
      code: 'request_too_large',
      message: 'That file is over 1 MB.',
      status: 413,
    });
    expect(
      readErrorBody({ title: 'Not found.', status: 404, code: 'not_found' }, 'HTTP 404')
    ).toEqual({ code: 'not_found', message: 'Not found.', status: 404 });
  });

  it('reads the code alone: a problem names its refusal in `code`, never a second member', () => {
    const changed = { title: 'Changed.', status: 412, code: 'precondition_failed' };
    expect(readErrorBody({ ...changed, reason: 'stale_approval' }, 'HTTP 412')).toEqual({
      code: 'precondition_failed',
      message: 'Changed.',
      status: 412,
    });
  });

  it('carries a problem’s issues and retry delay', () => {
    const issues = { formErrors: [], fieldErrors: { name: ['Required'] } };
    expect(
      readErrorBody(
        {
          title: 'The request could not be read.',
          status: 400,
          code: 'malformed_request',
          issues,
        },
        'x'
      ).issues
    ).toEqual(issues);
    expect(
      readErrorBody(
        { title: 'Slow down.', status: 429, code: 'rate_limited', retryAfterMs: 1500 },
        'x'
      ).retryAfterMs
    ).toBe(1500);
  });

  it('reads the old `{ error, code, details }` shape', () => {
    expect(readErrorBody({ error: 'Chat is busy', code: 'SESSION_LOCKED' }, 'HTTP 409')).toEqual({
      code: 'SESSION_LOCKED',
      message: 'Chat is busy',
    });
    const details = { formErrors: ['Bad'], fieldErrors: { cwd: ['Required'] } };
    expect(readErrorBody({ error: 'Validation failed', details }, 'x')).toEqual({
      message: 'Validation failed',
      issues: details,
    });
  });

  it('reads an old body that says `message` instead of `error`', () => {
    expect(readErrorBody({ message: 'Denied by policy', status: 'denied' }, 'x')).toEqual({
      message: 'Denied by policy',
    });
  });

  it('falls back for a body it cannot read', () => {
    for (const body of [null, undefined, 'oops', 42, {}, { error: 7 }]) {
      expect(readErrorBody(body, 'HTTP 500')).toEqual({ message: 'HTTP 500' });
    }
  });
});
