/**
 * @vitest-environment node
 *
 * A server the agent no longer gets is refused at its next call in a chat
 * already running (DOR-3872).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  REMOVED_SERVER_MESSAGE,
  managedServerHookMatcher,
  setManagedServerNames,
} from '../managed-server-deny.js';

const AGENT = '/made-up/agents/scout';

/** What the agent's folder gets right now; tests change it mid-chat. */
let names: string[] = [];

async function call(matcher: HookCallbackMatcher, toolName: string): Promise<unknown> {
  const [hook] = matcher.hooks;
  return hook!(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: {},
      tool_use_id: 'toolu_1',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/c',
    } as HookInput,
    'toolu_1',
    { signal: new AbortController().signal }
  );
}

const denied = { hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) };

afterEach(() => setManagedServerNames(() => []));

describe('managedServerHookMatcher', () => {
  it('matches MCP tools only, as a regex the CLI reads', () => {
    expect(managedServerHookMatcher(AGENT).matcher).toBe('^mcp__');
  });

  it('refuses a server removed after launch, and only that one', async () => {
    names = ['github', 'made-up.tracker'];
    setManagedServerNames(() => names);
    const hook = managedServerHookMatcher(AGENT);
    expect(await call(hook, 'mcp__github__create_issue')).toEqual({});
    names = ['made-up.tracker'];
    expect(await call(hook, 'mcp__github__create_issue')).toEqual(denied);
    expect(await call(hook, 'mcp__github__create_issue')).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: REMOVED_SERVER_MESSAGE },
    });
    expect(await call(hook, 'mcp__made-up_tracker__list')).toEqual({});
  });

  it('refuses a server this chat gained live and then lost', async () => {
    names = [];
    setManagedServerNames(() => names);
    const hook = managedServerHookMatcher(AGENT);
    names = ['github'];
    expect(await call(hook, 'mcp__github__x')).toEqual({});
    names = [];
    expect(await call(hook, 'mcp__github__x')).toEqual(denied);
  });

  it('lets it run again once the agent gets it back', async () => {
    names = ['github'];
    setManagedServerNames(() => names);
    const hook = managedServerHookMatcher(AGENT);
    names = [];
    expect(await call(hook, 'mcp__github__x')).toEqual(denied);
    names = ['github'];
    expect(await call(hook, 'mcp__github__x')).toEqual({});
  });

  it('never touches a server under another name: dorkos, a repo’s, the account’s', async () => {
    names = ['github'];
    setManagedServerNames(() => names);
    const hook = managedServerHookMatcher(AGENT);
    names = [];
    expect(await call(hook, 'mcp__dorkos__ping')).toEqual({});
    expect(await call(hook, 'mcp__repo-server__x')).toEqual({});
    expect(await call(hook, 'Bash')).toEqual({});
  });

  it('a removed server whose name starts another’s leaves the other running', async () => {
    names = ['a', 'a__b'];
    setManagedServerNames(() => names);
    const hook = managedServerHookMatcher(AGENT);
    names = ['a__b'];
    expect(await call(hook, 'mcp__a__b__tool')).toEqual({});
    expect(await call(hook, 'mcp__a__tool')).toEqual(denied);
  });

  it('refuses nothing for a chat with no agent folder', async () => {
    setManagedServerNames(() => ['github']);
    expect(await call(managedServerHookMatcher(null), 'mcp__github__x')).toEqual({});
  });
});
