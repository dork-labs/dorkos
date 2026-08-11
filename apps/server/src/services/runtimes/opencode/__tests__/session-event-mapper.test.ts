import { describe, it, expect, vi } from 'vitest';
import {
  mapPermissionAsked,
  mapPermissionReplied,
  type OpenCodePermissionState,
} from '../session-event-mapper.js';
import { mapOpenCodeEvent, createOpenCodeEventContext } from '../event-mapper.js';
import { SESSIONS } from '../../../../config/constants.js';
import type { ApprovalEvent } from '@dorkos/shared/types';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));

/**
 * The payloads below are VERBATIM from the shipped opencode 1.18.15 sidecar
 * (captured 2026-08-11 against a local Ollama model with the adapter's own
 * `edit/bash/webfetch: ask` ruleset). They are the contract this adapter is
 * held to — the SDK's generated types describe a `permission.updated` shape the
 * server has never emitted, which is exactly how DOR-1147 shipped a permission
 * path that could not fire.
 */
/**
 * A fresh turn's permission bookkeeping. The mapper records which session each
 * ask must be ANSWERED in here, so every call needs one (DOR-1126).
 */
function permissions(): OpenCodePermissionState {
  return { pendingPermissionSessions: new Map() };
}

const LIVE_BASH_ASKED = {
  id: 'per_ff0006910001mhtgQCU3N0PfUD',
  sessionID: 'ses_00fffd9b4ffew6F2oOAAHyfTnv',
  permission: 'bash',
  patterns: ['ls -F'],
  metadata: { command: 'ls -F' },
  always: ['ls *'],
  tool: { messageID: 'msg_ff00026590015JTxcnVnGMsGGg', callID: 'call_esj3yoqx' },
};

const LIVE_EDIT_ASKED = {
  id: 'per_ff0028eaf001B7M5Ovm8pZjFfe',
  sessionID: 'ses_00ffd799dffewAqWxHXryIJbhC',
  permission: 'edit',
  patterns: ['tmp/probe-edit.txt'],
  metadata: { filepath: '/tmp/probe-edit.txt', diff: 'Index: /tmp/probe-edit.txt\n+hello\n' },
  always: ['*'],
  tool: { messageID: 'msg_ff0028674001CtqskFYJhD8peZ', callID: 'call_8oj8rcfx' },
};

const LIVE_REPLIED = {
  sessionID: 'ses_00fffd9b4ffew6F2oOAAHyfTnv',
  requestID: 'per_ff0006910001mhtgQCU3N0PfUD',
  reply: 'once',
};

describe('permission.asked → approval_required', () => {
  it('maps the live bash payload to an approval keyed by the permission id', () => {
    const [event, ...rest] = mapPermissionAsked(LIVE_BASH_ASKED, permissions());
    expect(rest).toEqual([]);
    expect(event?.type).toBe('approval_required');
    const data = event?.data as ApprovalEvent;
    expect(data.toolCallId).toBe('per_ff0006910001mhtgQCU3N0PfUD');
    expect(data.toolName).toBe('bash');
    expect(JSON.parse(data.input)).toEqual({ patterns: ['ls -F'], command: 'ls -F' });
    expect(data.timeoutMs).toBe(SESSIONS.INTERACTION_TIMEOUT_MS);
    expect(data.startedAt).toBeGreaterThan(0);
    expect(data.hasSuggestions).toBe(false);
    // Nothing to say `Always allow` with: OpenCode's `always` would persist a
    // rule in ITS store, so the adapter never offers it.
    expect(data.blockedPath).toBeUndefined();
  });

  it('surfaces the file an edit request wants to touch', () => {
    const [event] = mapPermissionAsked(LIVE_EDIT_ASKED, permissions());
    const data = event?.data as ApprovalEvent;
    // `edit` is the exact permission key `acceptEdits` auto-approves on.
    expect(data.toolName).toBe('edit');
    expect(data.blockedPath).toBe('/tmp/probe-edit.txt');
  });

  it('drops a payload missing a field the approval depends on', () => {
    expect(mapPermissionAsked({ sessionID: 'ses_1', permission: 'bash' }, permissions())).toEqual([]);
    expect(mapPermissionAsked(undefined, permissions())).toEqual([]);
  });

  it('tolerates a request the sidecar sends with no patterns or metadata', () => {
    const [event] = mapPermissionAsked(
      { id: 'per_1', sessionID: 'ses_1', permission: 'webfetch' },
      permissions()
    );
    const data = event?.data as ApprovalEvent;
    expect(data.input).toBe('{}');
  });
});

describe('permission.replied → interaction_cancelled', () => {
  it('reads the id off the live field name', () => {
    expect(mapPermissionReplied(LIVE_REPLIED, permissions())).toEqual([
      { type: 'interaction_cancelled', data: { interactionId: 'per_ff0006910001mhtgQCU3N0PfUD' } },
    ]);
  });

  it('drops an echo whose id is missing rather than cancelling nothing', () => {
    // The SDK's stale declaration spells these `permissionID`/`response`; an
    // echo in that shape names no request and must not be acted on.
    expect(
      mapPermissionReplied(
        { sessionID: 'ses_1', permissionID: 'per_1', response: 'once' },
        permissions()
      )
    ).toEqual([]);
  });
});

describe('the turn mapper admits the events the sidecar really sends', () => {
  it('turns a live permission.asked into an approval', () => {
    const events = mapOpenCodeEvent(
      { type: 'permission.asked', properties: LIVE_BASH_ASKED },
      createOpenCodeEventContext('dork-session')
    );
    expect(events.map((e) => e.type)).toEqual(['approval_required']);
  });

  it('clears the card when a live permission.replied echo arrives', () => {
    const events = mapOpenCodeEvent(
      { type: 'permission.replied', properties: LIVE_REPLIED },
      createOpenCodeEventContext('dork-session')
    );
    expect(events).toEqual([
      { type: 'interaction_cancelled', data: { interactionId: LIVE_REPLIED.requestID } },
    ]);
  });
});
