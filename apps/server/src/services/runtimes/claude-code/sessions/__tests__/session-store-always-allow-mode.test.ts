/**
 * "Always Allow" keeps DorkOS's copy of the mode honest (DOR-1316).
 *
 * On a file-edit card the SDK's "don't ask me again" suggestion is not a tool
 * rule — it is a `setMode` to `acceptEdits`, scoped to the session. Forwarding
 * it really does move the live CLI into that mode. DorkOS used to forward it
 * and forget it, so the status line and the Session inspector read `acceptEdits`
 * back off the transcript while the stored settings still said `default` — and
 * the next process launched for that same session ran `--permission-mode
 * default` and asked all over again.
 *
 * These tests drive `approveTool` against a hand-registered pending approval and
 * pin three things: the mode is adopted, the suggestions still reach the SDK
 * verbatim, and nothing wider than the session moves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { SessionSettings } from '@dorkos/shared/types';
import { SessionStore } from '../session-store.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = 'session-answering-a-card';
/** The id the SDK renamed the conversation to — the key every reader asks by. */
const CANONICAL_ID = 'sdk-canonical-id';
const TOOL_CALL_ID = 'tool-write-1';

/** The suggestion a Write card carries: "don't ask me again in this chat". */
const SESSION_ACCEPT_EDITS: PermissionUpdate = {
  type: 'setMode',
  mode: 'acceptEdits',
  destination: 'session',
};

/** A store with one pending Write approval, plus what the answer produced. */
function storeWithPendingApproval(suggestions?: PermissionUpdate[]) {
  const saved: Array<{ id: string; settings: SessionSettings }> = [];
  const resolved: Array<boolean | PermissionUpdate[]> = [];
  const store = new SessionStore();
  store.configureSettings(
    {
      getSessionSettings: async () => null,
      saveSessionSettings: async (id, settings) => {
        saved.push({ id, settings });
      },
      rekeySessionSettings: async () => {},
    },
    'default'
  );
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  const session = store.findSession(SESSION_ID)!;
  session.pendingInteractions.set(TOOL_CALL_ID, {
    type: 'approval',
    toolCallId: TOOL_CALL_ID,
    resolve: (result) => {
      resolved.push(result);
    },
    reject: () => {},
    timeout: setTimeout(() => {}, 0),
    startedAt: Date.now(),
    ...(suggestions ? { suggestions } : {}),
    snapshot: {
      toolName: 'Write',
      input: '{}',
      hasSuggestions: (suggestions?.length ?? 0) > 0,
    },
  });
  clearTimeout(session.pendingInteractions.get(TOOL_CALL_ID)!.timeout);
  return { store, session, saved, resolved };
}

describe('"Always Allow" and the session mode (DOR-1316)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adopts the mode the click switches the CLI to, so the label and the next launch agree', async () => {
    const { store, session, saved, resolved } = storeWithPendingApproval([SESSION_ACCEPT_EDITS]);
    // The SDK renamed this conversation on its first turn, so the id the
    // cockpit answers the card with is an alias — exactly the shape the approve
    // route hands in. The row still has to land on the canonical id, which is
    // the only key the display overlay ever reads by.
    session.sdkSessionId = CANONICAL_ID;
    await store.rebindSdkSession(SESSION_ID, CANONICAL_ID, SESSION_ID);

    expect(store.approveTool(SESSION_ID, TOOL_CALL_ID, true, { alwaysAllow: true })).toBe(true);

    // What DorkOS enforces and what it launches with both read off this field.
    expect(session.permissionMode).toBe('acceptEdits');
    // …and it survives eviction, under the canonical id every reader asks by.
    await vi.waitFor(() =>
      expect(saved).toEqual([
        { id: session.sdkSessionId, settings: { permissionMode: 'acceptEdits' } },
      ])
    );
    // The grant itself is unchanged: the SDK still gets its own array, verbatim.
    expect(resolved).toEqual([[SESSION_ACCEPT_EDITS]]);
  });

  it('invents no mode from a standing tool allow — a rule is not a mode', async () => {
    const rule: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
      behavior: 'allow',
      destination: 'session',
    };
    const { store, session, saved, resolved } = storeWithPendingApproval([rule]);

    expect(store.approveTool(SESSION_ID, TOOL_CALL_ID, true, { alwaysAllow: true })).toBe(true);

    expect(session.permissionMode).toBe('default');
    expect(saved).toEqual([]);
    expect(resolved).toEqual([[rule]]);
  });

  it('leaves the operator’s wider settings alone — one card moves one chat', async () => {
    const global: PermissionUpdate = {
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'userSettings',
    };
    const { store, session, saved } = storeWithPendingApproval([global]);

    expect(store.approveTool(SESSION_ID, TOOL_CALL_ID, true, { alwaysAllow: true })).toBe(true);

    expect(session.permissionMode).toBe('default');
    expect(saved).toEqual([]);
  });

  it('moves nothing on a plain one-time approval', async () => {
    const { store, session, saved, resolved } = storeWithPendingApproval([SESSION_ACCEPT_EDITS]);

    expect(store.approveTool(SESSION_ID, TOOL_CALL_ID, true)).toBe(true);

    expect(session.permissionMode).toBe('default');
    expect(saved).toEqual([]);
    expect(resolved).toEqual([true]);
  });
});
