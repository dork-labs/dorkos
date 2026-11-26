/**
 * Shared setup for `agent-attachments.test.ts`: two agents' own folders under
 * one boundary, a real room with a real attachment store, and the helpers that
 * post as Ana and check that a refusal wrote nothing. The suite's rationale is
 * on the test file.
 *
 * The world is rebuilt per test; read it through these live bindings.
 *
 * @module server/services/rooms/attachments/__tests__/agent-attachments.fixtures
 */
import { beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { roomsDomain } from '../../room-capabilities.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../__tests__/room-test-harness.js';
import { LocalRoomAttachmentStore } from '../local-room-attachment-store.js';
import { setRoomAttachmentStores } from '../attachment-stores.js';
import type { RoomAttachmentStore } from '../room-attachment-store.js';

/** Ana's agent path. */
export const ANA_PATH = '/agents/ana';
/** Kai's agent path. */
export const KAI_PATH = '/agents/kai';
const agents = agentLookupFor({
  [ANA_PATH]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  [KAI_PATH]: { name: 'kai', displayName: 'Kai', responseMode: 'always' },
});

/** The smallest thing that reads as a GIF — what a recording arrives as. */
export const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8, 3)]);

/** A one-pixel PNG, so a `preview: 'image'` assertion means the bytes sniffed. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** The test's temporary root, holding both agents' folders and the data folder. */
export let root: string;
/**
 * Ana's working directory, and Kai's — two agents' own folders under one
 * boundary. A room turn stands in the agent's home, so these are homes; the
 * room copies a turn is granted are set up in their own block in the test.
 */
export let anaCwd: string;
/** Kai's working directory. */
export let kaiCwd: string;
/** Where the room's attachment bytes are stored. */
export let bytesHome: string;
/** The room's attachment byte store. */
export let store: RoomAttachmentStore;
/** The real room service and its stores. */
export let harness: RoomHarness;
/** The registry `rooms.post` is invoked through. */
export let registry: CapabilityRegistry;
/** The seeded room, with Ana and Kai in it. */
export let roomId: string;

/**
 * Stand Ana somewhere else for the rest of the test.
 *
 * @param dir - Her new working directory.
 */
export function moveAnaTo(dir: string): void {
  anaCwd = dir;
}

/**
 * Invoke `rooms.post` as Ana, standing in `cwd`.
 *
 * @param cwd - The working directory the call comes from.
 * @param input - The capability's input.
 */
export function postFrom(cwd: string, input: Record<string, unknown>): Promise<unknown> {
  return registry.invoke('rooms.post', input, {
    identity: { agentPath: ANA_PATH, displayName: 'Ana' },
    cwd,
  } as Parameters<CapabilityRegistry['invoke']>[2]);
}

/**
 * Invoke `rooms.post` as Ana, from Ana's own working directory.
 *
 * @param input - The capability's input.
 */
export function post(input: Record<string, unknown>): Promise<unknown> {
  return postFrom(anaCwd, input);
}

/** Every UNBOUND row this room holds — what a refusal must leave empty. */
export function unboundRows() {
  return harness.attachments.listUnboundBefore(roomId, new Date(Date.now() + 60_000).toISOString());
}

/**
 * One room's attachment directory, or `[]` when nothing ever wrote to it.
 *
 * Takes the room, because a post to a room id that does not exist stages under
 * THAT id — asserting against the real room's directory would be empty whether
 * the rollback ran or not.
 *
 * @param room - The room whose stored bytes to list. Defaults to the seeded one.
 */
export async function storedFiles(room: string = roomId): Promise<string[]> {
  return fs.readdir(path.join(bytesHome, 'rooms', room, 'attachments')).catch(() => []);
}

/** Nothing was written: no unbound rows, no bytes, no entry. */
export async function nothingWasWritten(): Promise<void> {
  expect(unboundRows()).toHaveLength(0);
  expect(await storedFiles()).toEqual([]);
  expect(harness.service.readHistory(roomId, harness.human, { limit: 10 })).toHaveLength(0);
}

/** Build the two agents' folders, the boundary, the room and its stores per test. */
export function useAttachmentWorld(): void {
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-agent-att-')));
    anaCwd = path.join(root, 'ana');
    kaiCwd = path.join(root, 'kai');
    bytesHome = path.join(root, 'dork');
    await fs.mkdir(anaCwd, { recursive: true });
    await fs.mkdir(kaiCwd, { recursive: true });
    // The boundary contains BOTH working copies, which is exactly the project-room
    // shape: `validateBoundary` alone would let Ana name Kai's file.
    await initBoundary(root);

    store = new LocalRoomAttachmentStore(bytesHome);
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    setRoomAttachmentStores({ attachments: store, rows: harness.attachments });
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA_PATH, KAI_PATH] },
      harness.human
    ).id;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
}
