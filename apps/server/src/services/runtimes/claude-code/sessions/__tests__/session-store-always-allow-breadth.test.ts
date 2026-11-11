/**
 * "Always Allow" on an MCP tool's card writes the rule the person picked
 * (DOR-4101). A bare `mcp__{server}` rule allows every tool that server has, now
 * and later, so it is written only when the person chose "Every tool from
 * {server}". "Just {tool}", and any answer that names no pick, writes the one
 * tool's rule instead.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from '../session-store.js';
import { alwaysAllowBreadthOf, narrowToTool } from '../../tool-gate/always-allow-breadth.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = 'session-answering-an-mcp-card';
const TOOL_CALL_ID = 'tool-mcp-1';
const TOOL = 'mcp__made-up__create_issue';

/** The CLI's suggestion that names the whole server. */
const SERVER_RULE: PermissionUpdate = {
  type: 'addRules',
  rules: [{ toolName: 'mcp__made-up' }],
  behavior: 'allow',
  destination: 'localSettings',
};

const TOOL_RULE: PermissionUpdate = { ...SERVER_RULE, rules: [{ toolName: TOOL }] };

function storeWithPendingApproval(suggestions: PermissionUpdate[]) {
  const resolved: Array<boolean | PermissionUpdate[]> = [];
  const store = new SessionStore();
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
    suggestions,
    snapshot: { toolName: TOOL, input: '{}', hasSuggestions: true },
  });
  clearTimeout(session.pendingInteractions.get(TOOL_CALL_ID)!.timeout);
  return { store, resolved };
}

describe('alwaysAllowBreadthOf', () => {
  it('reads a bare server rule as the whole server, and a tool rule as the tool', () => {
    expect(alwaysAllowBreadthOf(TOOL, [SERVER_RULE])).toBe('server');
    expect(alwaysAllowBreadthOf(TOOL, [TOOL_RULE])).toBe('tool');
  });

  it('says nothing for a card that is not an MCP tool’s, or offers no Always Allow', () => {
    expect(alwaysAllowBreadthOf('Write', [SERVER_RULE])).toBeUndefined();
    expect(alwaysAllowBreadthOf(TOOL, [])).toBeUndefined();
    expect(alwaysAllowBreadthOf(TOOL, undefined)).toBeUndefined();
  });

  it('a rule for another server, or one narrowed by content, is not this server', () => {
    const other = { ...SERVER_RULE, rules: [{ toolName: 'mcp__other' }] };
    const narrowed = { ...SERVER_RULE, rules: [{ toolName: 'mcp__made-up', ruleContent: 'x' }] };
    expect(alwaysAllowBreadthOf(TOOL, [other])).toBe('tool');
    expect(alwaysAllowBreadthOf(TOOL, [narrowed])).toBe('tool');
  });
});

describe('narrowToTool', () => {
  it('swaps the bare server rule for the tool’s, once, and keeps the rest', () => {
    const both: PermissionUpdate = {
      ...SERVER_RULE,
      rules: [{ toolName: 'mcp__made-up' }, { toolName: TOOL }, { toolName: 'Read' }],
    };
    expect(narrowToTool(TOOL, [both])).toEqual([
      { ...SERVER_RULE, rules: [{ toolName: TOOL }, { toolName: 'Read' }] },
    ]);
  });
});

describe('approveTool on an MCP card (DOR-4101)', () => {
  it('"Just {tool}" writes the one tool’s rule', () => {
    const { store, resolved } = storeWithPendingApproval([SERVER_RULE]);
    store.approveTool(SESSION_ID, TOOL_CALL_ID, true, {
      alwaysAllow: true,
      alwaysAllowBreadth: 'tool',
    });
    expect(resolved).toEqual([[TOOL_RULE]]);
  });

  it('an answer with no pick writes the one tool’s rule too', () => {
    const { store, resolved } = storeWithPendingApproval([SERVER_RULE]);
    store.approveTool(SESSION_ID, TOOL_CALL_ID, true, { alwaysAllow: true });
    expect(resolved).toEqual([[TOOL_RULE]]);
  });

  it('"Every tool from {server}" writes the server rule as offered', () => {
    const { store, resolved } = storeWithPendingApproval([SERVER_RULE]);
    store.approveTool(SESSION_ID, TOOL_CALL_ID, true, {
      alwaysAllow: true,
      alwaysAllowBreadth: 'server',
    });
    expect(resolved).toEqual([[SERVER_RULE]]);
  });
});
