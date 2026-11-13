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

function storeWithPendingApproval(suggestions: PermissionUpdate[], toolName = TOOL) {
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
    snapshot: { toolName, input: '{}', hasSuggestions: true },
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

describe('server rules in other shapes (DOR-4240)', () => {
  /** A server whose own name holds `__`: `made__up`, tool `create_issue`. */
  const DUNDER_TOOL = 'mcp__made__up__create_issue';
  const DUNDER_SERVER: PermissionUpdate = {
    ...SERVER_RULE,
    rules: [{ toolName: 'mcp__made__up' }],
  };
  const DUNDER_TOOL_RULE: PermissionUpdate = { ...SERVER_RULE, rules: [{ toolName: DUNDER_TOOL }] };
  const WILDCARD: PermissionUpdate = { ...SERVER_RULE, rules: [{ toolName: 'mcp__made-up__*' }] };

  const EVERY_MCP: PermissionUpdate = { ...SERVER_RULE, rules: [{ toolName: 'mcp__*' }] };

  it.each<[string, string, PermissionUpdate]>([
    ['a server whose name holds __', DUNDER_TOOL, DUNDER_SERVER],
    ['mcp__{server}__*', TOOL, WILDCARD],
    ['every MCP tool, mcp__*', TOOL, EVERY_MCP],
  ])('reads %s as the whole server', (_label, tool, rule) => {
    expect(alwaysAllowBreadthOf(tool, [rule])).toBe('server');
  });

  it('still reads the tool’s own rule, another server’s, or a narrowed one as not wide', () => {
    const sibling = { ...SERVER_RULE, rules: [{ toolName: 'mcp__made__upx' }] };
    const otherWildcard = { ...SERVER_RULE, rules: [{ toolName: 'mcp__other__*' }] };
    const narrowed = { ...SERVER_RULE, rules: [{ toolName: 'mcp__made__up', ruleContent: 'x' }] };
    expect(alwaysAllowBreadthOf(DUNDER_TOOL, [DUNDER_TOOL_RULE])).toBe('tool');
    expect(alwaysAllowBreadthOf(DUNDER_TOOL, [sibling])).toBe('tool');
    expect(alwaysAllowBreadthOf(TOOL, [otherWildcard])).toBe('tool');
    expect(alwaysAllowBreadthOf(DUNDER_TOOL, [narrowed])).toBe('tool');
  });

  it('an answer with no pick writes only the tool, for a server whose name holds __', () => {
    const { store, resolved } = storeWithPendingApproval([DUNDER_SERVER], DUNDER_TOOL);
    store.approveTool(SESSION_ID, TOOL_CALL_ID, true, { alwaysAllow: true });
    expect(resolved).toEqual([[DUNDER_TOOL_RULE]]);
  });

  it('"Just {tool}" writes only the tool when the CLI offered mcp__{server}__*', () => {
    const { store, resolved } = storeWithPendingApproval([WILDCARD]);
    store.approveTool(SESSION_ID, TOOL_CALL_ID, true, {
      alwaysAllow: true,
      alwaysAllowBreadth: 'tool',
    });
    expect(resolved).toEqual([[TOOL_RULE]]);
  });

  it('"Every tool from {server}" still writes either shape as offered', () => {
    const dunder = storeWithPendingApproval([DUNDER_SERVER], DUNDER_TOOL);
    dunder.store.approveTool(SESSION_ID, TOOL_CALL_ID, true, {
      alwaysAllow: true,
      alwaysAllowBreadth: 'server',
    });
    expect(dunder.resolved).toEqual([[DUNDER_SERVER]]);
    const wildcard = storeWithPendingApproval([WILDCARD]);
    wildcard.store.approveTool(SESSION_ID, TOOL_CALL_ID, true, {
      alwaysAllow: true,
      alwaysAllowBreadth: 'server',
    });
    expect(wildcard.resolved).toEqual([[WILDCARD]]);
  });
});
