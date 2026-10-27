/**
 * `control_ui` putting a LOCAL picture on a room's canvas — the case that used
 * to report success while every other member saw a card saying the file was
 * not theirs to view.
 *
 * Driven through the real SDK server and a real room service, over a real
 * filesystem: what matters is that the document that lands on the room's table
 * points at a copy the room can serve, and that a file outside the agent's own
 * folders is refused out loud instead of being reported as shared.
 *
 * @vitest-environment node
 * @module services/runtimes/claude-code/mcp-tools/tests/control-ui-target-media
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const uploads = { maxFileSize: 1024 * 1024, maxFiles: 3, allowedTypes: ['*/*'] };
vi.mock('../../../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) => (section === 'uploads' ? uploads : undefined),
    set: () => {},
  },
}));

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { noopLogger } from '@dorkos/shared/logger';
import { isRoomCanvasMediaUrl } from '@dorkos/shared/canvas-media-url';
import { capabilityMcpTools } from '../capability-mcp-tools.js';
import { composeRegistry } from '../../../../core/capabilities/index.js';
import { initBoundary } from '../../../../../lib/boundary.js';
import { uiDomain } from '../../../../session/browser-seat/ui-capabilities.js';
import { uiTurnFacts } from '../../../../session/browser-seat/ui-turn-facts.js';
import { findRoomCanvasMedia } from '../../../../rooms/canvas/room-canvas-media.js';
import { setRoomService } from '../../../../rooms/index.js';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../../session/session-state-projector.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../../rooms/__tests__/room-test-harness.js';

const SESSION_ID = 'session-ana-media';

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('control_ui putting a local file on a room', () => {
  let root: string;
  let anaPath: string;
  let benPath: string;
  let harness: RoomHarness;
  let backend: string;
  let client: Client;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-ui-media-')));
    anaPath = path.join(root, 'agents', 'ana');
    benPath = path.join(root, 'agents', 'ben');
    await fs.mkdir(path.join(anaPath, 'studio'), { recursive: true });
    await fs.mkdir(benPath, { recursive: true });
    await fs.writeFile(path.join(anaPath, 'studio', 'board.png'), PNG);
    await fs.writeFile(path.join(benPath, 'private.png'), PNG);
    await initBoundary(root);
    vi.stubEnv('DORK_HOME', path.join(root, 'dork'));

    harness = createRoomHarness({
      agents: agentLookupFor({
        [anaPath]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
        [benPath]: { name: 'ben', displayName: 'Ben', responseMode: 'always' },
      }),
      runner: scriptedRunner(() => null),
    });
    setRoomService(harness.service);
    backend = harness.service.createRoom(
      { kind: 'channel', title: 'Studio', members: [], agentPaths: [anaPath] },
      harness.human
    ).id;
    harness.authors.resolveAgent(anaPath, 'Ana');

    uiTurnFacts.clear();
    const registry = composeRegistry([uiDomain], { logger: noopLogger });
    const server = createSdkMcpServer({
      name: 'dorkos',
      version: '1.0.0',
      tools: capabilityMcpTools(registry, 'in-session', async () => ({
        sessionId: SESSION_ID,
        cwd: anaPath,
      })),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'media-probe', version: '0.0.0' });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
    getOrCreateProjector(SESSION_ID).ingest({ type: 'turn_start' } as never);
  });

  afterEach(async () => {
    disposeProjector(SESSION_ID);
    uiTurnFacts.clear();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Call `control_ui` the way a model does, and read its JSON answer back. */
  async function controlUi(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await client.callTool({
      name: 'control_ui',
      arguments: args,
    })) as CallToolResult;
    const text = result.content.find((block) => block.type === 'text');
    return JSON.parse((text as { text: string }).text) as Record<string, unknown>;
  }

  it('copies the picture into the room, so the document points at something members can load', async () => {
    const answer = await controlUi({
      action: 'open_canvas',
      content: { type: 'image', src: path.join(anaPath, 'studio', 'board.png'), alt: 'Board' },
      target: { roomId: backend },
    });
    expect(answer).toMatchObject({ success: true, target: 'room', roomId: backend });

    const [document] = harness.service.canvas.list(backend);
    const src = (document.content as { src: string }).src;
    expect(isRoomCanvasMediaUrl(src, backend)).toBe(true);
    const found = await findRoomCanvasMedia(
      path.join(root, 'dork', 'rooms'),
      backend,
      src.split('/').pop()!
    );
    expect(found?.contentType).toBe('image/png');
  });

  it('refuses a file outside the agent’s own folders, and puts nothing on the table', async () => {
    const answer = await controlUi({
      action: 'open_canvas',
      content: { type: 'image', src: path.join(benPath, 'private.png') },
      target: { roomId: backend },
    });
    expect(answer).toMatchObject({ success: false, target: 'room', roomId: backend });
    expect(String(answer.reason)).toContain('your own folder');
    expect(harness.service.canvas.list(backend)).toHaveLength(0);
  });
});
