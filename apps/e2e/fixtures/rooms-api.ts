/**
 * Server-side setup and teardown for the rooms browser tests.
 *
 * Rooms and agents live in SQLite for the life of the server, and the whole
 * cockpit suite shares one. So a test never reaches for a room another test
 * might be posting into: it seeds its own, uniquely named, through the same REST
 * API the cockpit uses, and puts everything away again afterwards.
 *
 * Seeding through the API rather than the UI is deliberate. A test about how a
 * room *renders* should fail when the rendering breaks, not when the create
 * flow does — and the create flow has its own test that drives the real buttons.
 *
 * @module fixtures/rooms-api
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

/** An agent this helper registered, as the tests need to refer to it. */
export interface SeededAgent {
  /** Mesh id, used to unregister it again. */
  id: string;
  /** The agent's directory — how rooms address it (`agentPaths`). */
  path: string;
  /** What the cockpit calls it: the DM picker's label and a DM's title. */
  name: string;
  /** The emoji every avatar of this agent must draw. */
  emoji: string;
}

/** One person or agent on a room's roster, as `GET /api/rooms/:id` returns it. */
interface RosterEntry {
  author: { id: string; kind: 'human' | 'agent' | 'system'; displayName: string; emoji?: string };
}

/** A room with its roster, as the create and read endpoints return it. */
export interface SeededRoom {
  id: string;
  kind: 'channel' | 'dm' | 'thread';
  slug: string | null;
  title: string;
  members: RosterEntry[];
}

/**
 * Every agent registered for a room test is `silent`, whatever the room kind.
 *
 * A DM member's response mode is seeded from the agent's own manifest, and the
 * shipped default is `always` — so posting into a seeded DM on the default
 * runtime would trigger a real agent turn, which is neither fast nor
 * deterministic and costs money. Nothing in this suite is about an agent
 * replying, so nothing here asks one to.
 */
const SILENT = { responseMode: 'silent' } as const;

/**
 * How long to give an assertion that cannot pass until the server answers — a
 * room list refetched after a create, an entry delivered over the room's SSE
 * stream, a navigation that waits on a create mutation.
 *
 * Six times Playwright's 5s default, and deliberately so. This is a **ceiling,
 * not a delay**: a web-first assertion returns the moment it is satisfied, so
 * every one of these resolves in tens of milliseconds on an idle machine and
 * the suite finishes in well under a minute. What the ceiling buys is survival
 * on a machine that is not idle — this repo is routinely several worktrees deep
 * in concurrent agents, each running its own dev server and build, and measured
 * against that the same assertions that answer in 30ms at a load average of 5
 * need seconds at 200. Sizing for the real environment is not the same as
 * sleeping in it; nothing here polls or waits a fixed amount.
 */
export const SERVER_ROUND_TRIP_MS = 30_000;

/**
 * Seeds and cleans up the rooms, agents and entries one browser test needs.
 *
 * Every call records what it made, and {@link RoomsApi.cleanup} undoes it. Rooms
 * are archived rather than deleted because archiving is the only removal the
 * product has (spec `rooms` §12.4 — there is no Leave), and an archived room
 * leaves the sidebar and releases its `#slug`.
 */
export class RoomsApi {
  private readonly request: APIRequestContext;
  private readonly roomIds: string[] = [];
  private readonly agentIds: string[] = [];

  /** A short id, unique per instance, for naming fixtures apart. */
  readonly runId = randomUUID().slice(0, 8);

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  /**
   * Put the onboarding wizard away so the app shell renders.
   *
   * A `DORK_HOME` that has never been onboarded — a fresh worktree, a throwaway
   * data dir — opens on the wizard instead of the cockpit, and no sidebar test
   * can run against that.
   *
   * Reads before it writes, so a run only ever writes config once. The config
   * store is one file behind a read-modify-write, and every test in a fully
   * parallel suite calling this would have them clobbering each other for a
   * value that is already set.
   */
  async dismissOnboarding(): Promise<void> {
    const current = await this.request.get('/api/config');
    if (!current.ok()) {
      throw new Error(`Could not read config: ${current.status()} ${await current.text()}`);
    }
    const { onboarding } = (await current.json()) as { onboarding?: { dismissedAt?: string } };
    if (onboarding?.dismissedAt) return;

    const res = await this.request.patch('/api/config', {
      data: { onboarding: { dismissedAt: new Date().toISOString() } },
    });
    if (!res.ok()) {
      throw new Error(`Could not dismiss onboarding: ${res.status()} ${await res.text()}`);
    }
  }

  /**
   * Register an agent with a face of its own, and remember to unregister it.
   *
   * The emoji and colour are set at registration because nothing else can set
   * them: neither create endpoint writes a `color`, and an agent with no stored
   * emoji is exactly the state that made rooms look wired-up while drawing a
   * letter (spec `rooms` §12.2). A test about faces has to seed one.
   *
   * @param name - Display name, which is also the DM picker's label.
   * @param emoji - The face every avatar of this agent must draw.
   * @param color - The identity colour its disc is tinted from.
   */
  async registerAgent(name: string, emoji: string, color: string): Promise<SeededAgent> {
    const path = join(homedir(), '.dork-e2e-fixtures', `room-agent-${randomUUID()}`);
    const res = await this.request.post('/api/mesh/agents', {
      data: {
        path,
        overrides: { name, runtime: 'claude-code', icon: emoji, color, behavior: SILENT },
      },
    });
    if (!res.ok()) throw new Error(`Could not register ${name}: ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };
    this.agentIds.push(id);
    return { id, path, name, emoji };
  }

  /**
   * Create a channel, naming its `#slug` outright rather than letting the server
   * derive one, so the tests assert a string they chose.
   *
   * @param slug - The channel's `#name`, which must be unique among live channels.
   * @param title - Its display title. Defaults to the slug.
   */
  async createChannel(slug: string, title = slug): Promise<SeededRoom> {
    return this.createRoom({ kind: 'channel', slug, title });
  }

  /**
   * Start a direct message with one agent or several.
   *
   * @param title - What to call it. Group titles read the way
   *   `directMessageTitle` writes them ("Ana and Kai").
   * @param agents - Who is in it, in the order the roster should hold them.
   */
  async createDirectMessage(title: string, agents: SeededAgent[]): Promise<SeededRoom> {
    return this.createRoom({ kind: 'dm', title, agentPaths: agents.map((a) => a.path) });
  }

  /**
   * Post entries into a room as the local human, oldest first.
   *
   * Sequential rather than concurrent: `seq` is allocated per room and the tests
   * assert on the resulting order.
   *
   * @param roomId - The room to post into.
   * @param texts - One entry per string.
   */
  async postEntries(roomId: string, texts: string[]): Promise<void> {
    for (const text of texts) {
      const res = await this.request.post(`/api/rooms/${roomId}/entries`, { data: { text } });
      if (res.status() !== 202) {
        throw new Error(`Post to ${roomId} answered ${res.status()}: ${await res.text()}`);
      }
    }
  }

  /**
   * Hand a room this helper did not create — one a test made by clicking
   * through the cockpit — to the same teardown, so it does not outlive the test.
   *
   * @param roomId - The room to archive at the end.
   */
  track(roomId: string): void {
    this.roomIds.push(roomId);
  }

  /**
   * Read a room back with its roster resolved.
   *
   * @param roomId - The room to read.
   */
  async getRoom(roomId: string): Promise<SeededRoom> {
    const res = await this.request.get(`/api/rooms/${roomId}`);
    if (!res.ok()) throw new Error(`Could not read room ${roomId}: ${await res.text()}`);
    return (await res.json()) as SeededRoom;
  }

  /**
   * Archive every room this instance made and unregister every agent.
   *
   * Failures are swallowed on purpose: teardown runs after a test has already
   * decided its verdict, and a cleanup error reported as a test failure hides
   * the real one.
   */
  async cleanup(): Promise<void> {
    for (const id of this.roomIds) {
      await this.request.patch(`/api/rooms/${id}`, { data: { archived: true } }).catch(() => {});
    }
    for (const id of this.agentIds) {
      await this.request.delete(`/api/mesh/agents/${id}/data`).catch(() => {});
    }
  }

  /** Create a room of any kind and remember it for teardown. */
  private async createRoom(data: Record<string, unknown>): Promise<SeededRoom> {
    const res = await this.request.post('/api/rooms', { data });
    if (!res.ok()) throw new Error(`Could not create room: ${await res.text()}`);
    const room = (await res.json()) as SeededRoom;
    this.roomIds.push(room.id);
    return room;
  }
}
