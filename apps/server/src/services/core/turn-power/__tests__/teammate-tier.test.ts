/**
 * The teammate fence's decisions (DOR-2955): a teammate's turn reaches the room it answers, with
 * no files, and nothing else.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DORKOS_AGENT_TOOLS } from '../../../runtimes/claude-code/messaging/interactive-handlers.js';
import { IN_SESSION_TOOL_PREFIX } from '../../../runtimes/claude-code/mcp-tools/tool-exposure.js';
import {
  TEAMMATE_DORKOS_TOOLS,
  teammateTierDecision,
  TEAMMATE_TIER_DENIAL,
  teammateTierRefusal,
} from '../teammate-tier.js';

const FENCE = { roomId: 'room-answered', sharedFolder: null };

const dorkos = (name: string, input: Record<string, unknown> = {}) =>
  teammateTierRefusal(FENCE, { source: 'dorkos', name, input });

describe('the teammate fence', () => {
  it('decides every DorkOS tool an agent may call without a card', () => {
    // A tool added to the card-free list without a decision here would be refused, which is safe,
    // but it would also be a decision nobody made: this keeps the two lists reviewed together.
    const cardFree = [...DORKOS_AGENT_TOOLS].map((name) =>
      name.slice(IN_SESSION_TOOL_PREFIX.length)
    );
    // The shared-folder tools are the one exception: the tier allows them itself (DOR-2956).
    const decided = Object.entries(TEAMMATE_DORKOS_TOOLS)
      .filter(([, rule]) => rule.kind !== 'shared-folder')
      .map(([name]) => name);
    expect(decided.sort()).toEqual(cardFree.sort());
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
      expect(dorkos(name, { roomId: 'room-of-the-owner' })).toBe(TEAMMATE_TIER_DENIAL);
      expect(dorkos(name, {})).toBe(TEAMMATE_TIER_DENIAL);
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
    expect(dorkos(name, { roomId: 'room-answered' })).toBe(TEAMMATE_TIER_DENIAL);
  });

  it('refuses a DorkOS tool nobody decided about', () => {
    expect(dorkos('tasks_create', { roomId: 'room-answered' })).toBe(TEAMMATE_TIER_DENIAL);
    expect(dorkos('__proto__')).toBe(TEAMMATE_TIER_DENIAL);
  });

  // The review's BLOCKER: a name-only allowance let these reach every directory the owner's
  // settings grant, a private repository and the transcript store included.
  it.each([
    ['Read', { file_path: '/Users/x/Keep/dork-os/dorkos-cloud/secrets.ts' }],
    ['Read', { file_path: 'MEMORY.md' }],
    ['Read', { file_path: '.env' }],
    ['Grep', { pattern: 'token', path: '/Users/x' }],
    ['Glob', { pattern: '~/.claude/projects/**/*.jsonl' }],
    ['LS', { path: '/' }],
    ['NotebookRead', { notebook_path: 'analysis.ipynb' }],
  ])('refuses %s at any path (%o)', (name, input) => {
    expect(teammateTierRefusal(FENCE, { source: 'built-in', name, input })).toBe(
      TEAMMATE_TIER_DENIAL
    );
  });

  it('lets the to-do list through and nothing else the runtime has', () => {
    expect(
      teammateTierRefusal(FENCE, { source: 'built-in', name: 'TodoWrite', input: {} })
    ).toBeNull();
    for (const name of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task', 'Agent']) {
      expect(teammateTierRefusal(FENCE, { source: 'built-in', name, input: {} })).toBe(
        TEAMMATE_TIER_DENIAL
      );
    }
  });

  it('lists the room’s canvas but reads no document on it, which can be a file off disk', () => {
    expect(dorkos('read_canvas', { roomId: 'room-answered' })).toBeNull();
    expect(dorkos('read_canvas', { roomId: 'room-answered', documentId: 'doc-1' })).toBe(
      TEAMMATE_TIER_DENIAL
    );
  });

  it('counts any attachments value but an empty list as a file', () => {
    expect(dorkos('post_to_room', { roomId: 'room-answered', text: 'here', attachments: '' })).toBe(
      TEAMMATE_TIER_DENIAL
    );
  });

  it('refuses a post to the room that carries a file, and lets one without through', () => {
    expect(
      dorkos('post_to_room', { roomId: 'room-answered', text: 'here', attachments: ['.env'] })
    ).toBe(TEAMMATE_TIER_DENIAL);
    expect(
      dorkos('post_to_room', { roomId: 'room-answered', text: 'here', attachments: [] })
    ).toBeNull();
    expect(dorkos('post_to_room', { roomId: 'room-answered', text: 'here' })).toBeNull();
  });

  it('refuses every tool another MCP server serves, the owner’s connected apps included', () => {
    expect(
      teammateTierRefusal(FENCE, {
        source: 'mcp',
        name: 'mcp__github__create_issue',
        input: { roomId: 'room-answered' },
      })
    ).toBe(TEAMMATE_TIER_DENIAL);
  });
});

describe('the shared folder (DOR-2956)', () => {
  it('allows a Read of a shared file by its resolved path, and refuses every other', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'tier-read-')));
    try {
      const shared = path.join(base, 'acme');
      await mkdir(shared);
      await writeFile(path.join(shared, 'plan.md'), 'plan');
      await writeFile(path.join(base, 'secret.md'), 'secret');
      const scope = { roomId: 'room-answered', sharedFolder: shared };
      const read = (file: string) =>
        teammateTierDecision(scope, {
          source: 'built-in',
          name: 'Read',
          input: { file_path: file },
        });
      expect(await read(`${shared}/../acme/plan.md`)).toEqual({
        allowRead: { filePath: path.join(shared, 'plan.md') },
      });
      expect(await read(path.join(base, 'secret.md'))).toHaveProperty('refuse');
      expect(
        await teammateTierDecision(
          { roomId: 'room-answered', sharedFolder: null },
          { source: 'built-in', name: 'Read', input: { file_path: path.join(shared, 'plan.md') } }
        )
      ).toHaveProperty('refuse');
      // Glob, Grep and LS stay refused even with a shared folder.
      for (const name of ['Glob', 'Grep', 'LS']) {
        expect(
          await teammateTierDecision(scope, { source: 'built-in', name, input: { path: shared } })
        ).toHaveProperty('refuse');
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('lets the shared-folder tools run only when the space shares a folder', () => {
    const call = (name: string) => ({ source: 'dorkos' as const, name, input: {} });
    for (const name of ['shared_files_list', 'shared_files_search']) {
      expect(teammateTierRefusal({ roomId: 'r', sharedFolder: '/x' }, call(name))).toBeNull();
      expect(teammateTierRefusal({ roomId: 'r', sharedFolder: null }, call(name))).toBe(
        TEAMMATE_TIER_DENIAL
      );
    }
  });

  it('allows the shared-folder tools past the runtime’s gate itself, with a folder only', async () => {
    const call = { source: 'dorkos' as const, name: 'shared_files_search', input: {} };
    expect(await teammateTierDecision({ roomId: 'r', sharedFolder: '/x' }, call)).toEqual({
      allow: true,
    });
    expect(await teammateTierDecision({ roomId: 'r', sharedFolder: null }, call)).toHaveProperty(
      'refuse'
    );
  });
});
