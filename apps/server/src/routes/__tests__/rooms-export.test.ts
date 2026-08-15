/**
 * `GET /api/rooms/:id/export` through the real app mount (DOR-1225).
 *
 * The service tests beside this one own what the file SAYS; this one owns what
 * comes over the wire — the media type, the download headers, the line framing,
 * and the refusal a non-member gets before a single byte is written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import {
  RoomExportLineSchema,
  type RoomExportEntry,
  type RoomExportHeader,
  type RoomExportLine,
  type RoomExportSummary,
} from '@dorkos/shared/room-export-schemas';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { createApp, finalizeApp } from '../../app.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';

/** Register an agent so a room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

/** Parse a JSONL body into its three parts, validating every line. */
function parseExport(body: string): {
  header: RoomExportHeader;
  entries: RoomExportEntry[];
  summary: RoomExportSummary;
} {
  const lines: RoomExportLine[] = body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => RoomExportLineSchema.parse(JSON.parse(line)));
  const header = lines[0];
  const summary = lines[lines.length - 1];
  if (header?.type !== 'room-export') throw new Error('the first line was not a header');
  if (summary?.type !== 'summary') throw new Error('the last line was not a summary');
  return { header, entries: lines.slice(1, -1) as RoomExportEntry[], summary };
}

describe('GET /api/rooms/:id/export', () => {
  let db: Db;
  let roomId: string;

  beforeEach(async () => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);

    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Backend', topic: 'the API' });
    roomId = created.body.id;
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('serves the room as newline-delimited JSON, offered as a download', async () => {
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'first' });
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'second' });

    const res = await request(app).get(`/api/rooms/${roomId}/export`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('attachment; filename="room-backend-');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const { header, entries, summary } = parseExport(res.text);
    expect(header.room).toMatchObject({ id: roomId, title: 'Backend', topic: 'the API' });
    expect(entries.map((entry) => entry.text)).toEqual(['first', 'second']);
    expect(summary.entryCount).toBe(2);
  });

  it('writes one JSON object per line, and nothing else', async () => {
    await request(app)
      .post(`/api/rooms/${roomId}/entries`)
      .send({ text: 'a message\nwith a break' });

    const res = await request(app).get(`/api/rooms/${roomId}/export`);

    const lines = res.text.split('\n').filter((line) => line.length > 0);
    // Three lines for three objects: the newline inside the message must have
    // been escaped by JSON.stringify rather than splitting the record in two.
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(res.text.endsWith('\n')).toBe(true);
  });

  it('answers 404 for a room the caller may not see, with no partial body', async () => {
    const res = await request(app).get('/api/rooms/room_nope/export');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROOM_NOT_FOUND');
    // The refusal is a JSON error, not a truncated export: the header line is
    // pulled from the generator BEFORE any response header is written.
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('exports as whoever is asking — an agent gets only what was said after it joined', async () => {
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'before ana' });
    await request(app).post(`/api/rooms/${roomId}/members`).send({ agentPath: ANA_PATH });
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'after ana' });

    const asAna = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .set('X-DorkOS-Agent', token);
    const asOperator = await request(app).get(`/api/rooms/${roomId}/export`);

    // The token decides who is exporting, and nothing about the request does.
    // Same room, same moment, two different files.
    expect(parseExport(asAna.text).header.scope.joinFloorApplied).toBe(true);
    expect(parseExport(asAna.text).entries.map((entry) => entry.text)).toEqual(['after ana']);
    expect(parseExport(asOperator.text).header.scope.joinFloorApplied).toBe(false);
    expect(parseExport(asOperator.text).entries.map((entry) => entry.text)).toEqual([
      'before ana',
      'after ana',
    ]);
  });
});
