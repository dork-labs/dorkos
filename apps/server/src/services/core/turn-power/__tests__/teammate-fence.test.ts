/**
 * The teammate fence's decisions (DOR-2955): a teammate's turn reaches the room it answers and
 * the agent's own files, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { DORKOS_AGENT_TOOLS } from '../../../runtimes/claude-code/messaging/interactive-handlers.js';
import { IN_SESSION_TOOL_PREFIX } from '../../../runtimes/claude-code/mcp-tools/tool-exposure.js';
import {
  TEAMMATE_DORKOS_TOOLS,
  TEAMMATE_FENCE_DENIAL,
  teammateFenceRefusal,
} from '../teammate-fence.js';

const FENCE = { roomId: 'room-answered' };

const dorkos = (name: string, input: Record<string, unknown> = {}) =>
  teammateFenceRefusal(FENCE, { source: 'dorkos', name, input });

describe('the teammate fence', () => {
  it('decides every DorkOS tool an agent may call without a card', () => {
    // A tool added to the card-free list without a decision here would be refused, which is safe,
    // but it would also be a decision nobody made: this keeps the two lists reviewed together.
    const cardFree = [...DORKOS_AGENT_TOOLS].map((name) =>
      name.slice(IN_SESSION_TOOL_PREFIX.length)
    );
    expect(Object.keys(TEAMMATE_DORKOS_TOOLS).sort()).toEqual(cardFree.sort());
  });

  it.each(['post_to_room', 'react_to_room_entry', 'read_room_history', 'search_room_history'])(
    'lets %s reach the room the turn answers',
    (name) => {
      expect(dorkos(name, { roomId: 'room-answered' })).toBeNull();
    }
  );

  it.each(['post_to_room', 'read_room_history', 'search_room_history', 'get_room', 'read_canvas'])(
    'refuses %s in any other room, or with no room named',
    (name) => {
      expect(dorkos(name, { roomId: 'room-of-the-owner' })).toBe(TEAMMATE_FENCE_DENIAL);
      expect(dorkos(name, {})).toBe(TEAMMATE_FENCE_DENIAL);
    }
  );

  it.each([
    'list_member_rooms',
    'search_member_rooms',
    'find_room',
    'create_room',
    'add_room_members',
    'chat_send',
    'chat_read',
    'chat_stop',
    'mesh_register',
    'mesh_list',
    'memory_write',
    'relay_notify_user',
    'request_permission',
    'control_ui',
  ])('refuses %s even when it names the room', (name) => {
    expect(dorkos(name, { roomId: 'room-answered' })).toBe(TEAMMATE_FENCE_DENIAL);
  });

  it('refuses a DorkOS tool nobody decided about', () => {
    expect(dorkos('tasks_create', { roomId: 'room-answered' })).toBe(TEAMMATE_FENCE_DENIAL);
    expect(dorkos('__proto__')).toBe(TEAMMATE_FENCE_DENIAL);
  });

  it('lets the runtime’s own reads through and nothing else it has', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite']) {
      expect(teammateFenceRefusal(FENCE, { source: 'built-in', name, input: {} })).toBeNull();
    }
    for (const name of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'Agent']) {
      expect(teammateFenceRefusal(FENCE, { source: 'built-in', name, input: {} })).toBe(
        TEAMMATE_FENCE_DENIAL
      );
    }
  });

  it('refuses every tool another MCP server serves, the owner’s connected apps included', () => {
    expect(
      teammateFenceRefusal(FENCE, {
        source: 'mcp',
        name: 'mcp__github__create_issue',
        input: { roomId: 'room-answered' },
      })
    ).toBe(TEAMMATE_FENCE_DENIAL);
  });
});
