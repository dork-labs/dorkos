/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { chatToolsLine, renderDoeContextEntry } from '../context.js';
import { connectionToolName } from '../mcp.js';
describe('Doe context tool names', () => {
  it('names bare authenticated host tools and exact hashed private connection aliases', () => {
    const context = renderDoeContextEntry({
      kind: 'accounts_access',
      scope: 'per-turn',
      data: { accountCount: 1, changed: false, serviceCatalog: true },
    });
    expect(context).toContain(connectionToolName('connectors.list_granted_connections'));
    expect(context).not.toContain('mcp__dorkos');
  });
  it('teaches the real memory and compaction verbs', () => {
    const context = renderDoeContextEntry({
      kind: 'context_warning',
      scope: 'per-turn',
      data: { percent: 81, canCompact: true },
    });
    expect(context).toContain('memory_write');
    expect(context).toContain('compact_my_session');
    expect(context).not.toContain('mcp__');
  });
  // DOR-2790: Doe gets DorkOS tools only through the host server, which carries
  // the capability tools. mesh_list and mesh_inspect never reach it.
  it('names only the chat tools Doe really has loaded', () => {
    const line = chatToolsLine(true, true, new Set());
    expect(line).toContain('chat_send and chat_read are loaded');
    expect(line).not.toContain('mesh_list');
    expect(line).not.toContain('mesh_inspect');
  });
  it('claims no chat tool without the host, outside an agent session, or when hidden', () => {
    expect(chatToolsLine(false, true, new Set())).toBe('');
    expect(chatToolsLine(true, false, new Set())).toBe('');
    expect(chatToolsLine(true, true, new Set(['chat_send', 'chat_read']))).toBe('');
    const partial = chatToolsLine(true, true, new Set(['chat_send']));
    expect(partial).not.toContain('chat_send');
    expect(partial).toContain('chat_read is loaded');
  });
  it('renders generic neutral data in the context tag', () => {
    expect(
      renderDoeContextEntry({
        kind: 'env',
        scope: 'per-turn',
        data: { cwd: '/workspace' },
      } as never)
    ).toContain('/workspace');
  });
});

import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDoeContext } from '../context.js';
import { resetMemoryProvider } from '../../../memory/index.js';
import { testHome } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
it('reads own SOUL and refreshed MemoryProvider snapshots while environment stays at the desk', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'doe-context-')));
  try {
    resetMemoryProvider();
    const home = path.join(root, 'agent'),
      cwd = path.join(root, 'desk'),
      dork = path.join(home, '.dork');
    await mkdir(dork, { recursive: true });
    await mkdir(cwd);
    await writeFile(
      path.join(dork, 'agent.json'),
      JSON.stringify({
        id: '01JAGENT0000000000000000',
        name: 'researcher',
        displayName: 'Researcher',
        description: 'Reads carefully.',
        runtime: 'doe',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: '2026-01-01T00:00:00.000Z',
        registeredBy: 'test',
      })
    );
    await writeFile(path.join(dork, 'SOUL.md'), 'I am the canonical colleague.');
    await writeFile(path.join(dork, 'MEMORY.md'), 'First memory note');
    const first = await buildDoeContext({ cwd, agentPath: testHome(home), hostConnected: false });
    expect(first).toContain('I am the canonical colleague.');
    expect(first).toContain('First memory note');
    expect(first).toContain(cwd);
    expect(first.match(/I am the canonical colleague\./g)).toHaveLength(1);
    await writeFile(path.join(dork, 'MEMORY.md'), 'Fresh memory note');
    const next = await buildDoeContext({ cwd, agentPath: testHome(home), hostConnected: false });
    expect(next).toContain('Fresh memory note');
    expect(next).not.toContain('First memory note');
  } finally {
    resetMemoryProvider();
    await rm(root, { recursive: true, force: true });
  }
});

import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
const neutralEntries: AdditionalContextEntry[] = [
  { kind: 'git_status', scope: 'per-turn', data: { isRepo: false } },
  {
    kind: 'ui_state',
    scope: 'per-turn',
    data: {
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: false },
      agent: { id: null, cwd: null },
    },
  },
  { kind: 'queue_note', scope: 'per-turn', data: { composedDuringPrevTurn: true } },
  { kind: 'staged_context', scope: 'per-turn', data: { text: 'staged material' } },
  {
    kind: 'env',
    scope: 'per-session',
    data: {
      workingDirectory: '/desk',
      product: 'DorkOS',
      version: '0.0.0',
      port: 4242,
      platform: 'darwin',
      osVersion: 'test',
      nodeVersion: '22',
      hostname: 'test',
    },
  },
  {
    kind: 'relay_context',
    scope: 'per-turn',
    data: {
      agentId: 'agent',
      sessionId: 'session',
      from: 'relay.agent.peer',
      messageId: 'message',
      subject: 'relay.agent.self',
      sent: '2026-10-08T00:00:00.000Z',
    },
  },
  { kind: 'seed_context', scope: 'per-turn', data: { text: 'seed material' } },
  {
    kind: 'approval_verdict',
    scope: 'per-turn',
    data: {
      approvalId: 'approval',
      capabilityTitle: 'Change files',
      outcome: 'granted',
      endedAt: '2026-10-08T00:00:00.000Z',
    },
  },
  {
    kind: 'doc_events',
    scope: 'per-turn',
    data: {
      documentId: 'document',
      documentLabel: 'Document',
      scope: 'scope',
      batchId: 'batch',
      routeId: 'route',
      grantId: 'grant',
      events: [],
    },
  },
  {
    kind: 'room_context',
    scope: 'per-turn',
    data: {
      room: { id: 'room', name: '#room', kind: 'channel', bridged: false },
      thread: null,
      members: [],
      working: [],
      pending: [
        {
          id: 'message',
          authorHandle: 'person',
          authorDisplayName: 'Person',
          authorIsPerson: true,
          authorOrigin: 'local',
          kind: 'post',
          at: '2026-10-08T00:00:00.000Z',
          text: 'Untrusted member text',
          mentionsMe: false,
          attachments: [],
          topicLabel: null,
        },
      ],
      pendingTruncated: false,
      ownRecent: [],
      acknowledgments: [],
      triggerEntryId: 'entry',
      triggerAttachments: [],
      addressing: {
        responseMode: 'always',
        engagedUntil: null,
        engagedPostsLeft: null,
        addressedNow: false,
      },
      budget: {
        automaticRepliesLeftInThisRoomThisHour: 10,
        automaticRepliesLeftInTotalThisHour: 10,
        repliesLeftInThisChain: 2,
      },
    },
  },
];
it.each(neutralEntries)('carries neutral $kind context through its shared formatter', (entry) => {
  const rendered = renderDoeContextEntry(entry);
  expect(rendered).toContain(`<${entry.kind}>`);
  expect(rendered).toContain(`</${entry.kind}>`);
  if (entry.kind === 'room_context') {
    expect(rendered).toContain('UNTRUSTED');
    expect(rendered).toContain('post_to_room');
    expect(rendered).not.toContain('mcp__');
  }
  if (entry.kind === 'doc_events') expect(rendered).toContain('UNTRUSTED DOCUMENT EVENTS');
});
