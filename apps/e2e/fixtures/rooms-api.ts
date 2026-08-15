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
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

/**
 * Where every seeded agent directory lives, and the scan root they are all
 * registered against.
 *
 * Inside the repo's gitignored `.temp`, deliberately. Registering an agent hands
 * the server a path and the server creates it, so this choice has to satisfy
 * three constraints at once:
 *
 * - **In the boundary.** The server refuses an agent path outside
 *   `DORKOS_BOUNDARY`, which defaults to the home directory. A root under the
 *   checkout is therefore only in bounds while the checkout itself sits under
 *   `$HOME` — which is why `playwright.config.ts` points the cockpit leg's
 *   boundary at the checkout rather than leaving it to chance. Stating that
 *   constraint and relying on it held is what made the suite fail 14 ways from
 *   a worktree in `/private/tmp`.
 * - **In the boundary for *deletion* too.** `DELETE /api/mesh/agents/:id/data`
 *   re-checks the path without the dork-home allowance, so `{dorkHome}/agents`
 *   would register fine and then refuse to unregister, silting up the mesh.
 * - **Ours to delete.** The previous home, `~/.dork-e2e-fixtures`, was in
 *   bounds but nobody's to sweep: unregistering removes only `<path>/.dork`, so
 *   the directory the server created stayed behind. It had reached 546 of them.
 *
 * A path under the checkout satisfies all three and is disposable by
 * construction. It doubles as the `scanRoot`, which is what gives every agent in
 * one run the same namespace — agents in different namespaces cannot address
 * each other, which the mention and DM specs depend on.
 */
const FIXTURE_AGENT_ROOT = join(import.meta.dirname, '..', '.temp', 'fixtures');

/** An agent this helper registered, as the tests need to refer to it. */
export interface SeededAgent {
  /** Mesh id, used to unregister it again. */
  id: string;
  /** The agent's directory — how rooms address it (`agentPaths`). */
  path: string;
  /**
   * The path as the server canonicalized it, which is what config and rosters
   * store. Read back from the registry rather than assumed: registration
   * realpath-resolves what it is given, so on a machine where any segment is a
   * symlink this differs from {@link SeededAgent.path}, and an assertion
   * comparing against the sent path would fail for a reason that has nothing to
   * do with the behaviour under test.
   */
  projectPath: string;
  /** What the cockpit calls it: the DM picker's label and a DM's title. */
  name: string;
  /** The emoji every avatar of this agent must draw. */
  emoji: string;
}

/**
 * One entry of a seeded room, as the history route returns it.
 *
 * `body.notice` is what makes an entry the room speaking rather than somebody
 * in it — a notice is an ordinary row whose body says so, which is how the
 * cockpit tells them apart too (`RoomNoticeRow`). `authorId` is the only handle
 * on WHO said something: a reply carries no name on it, only the id its author
 * resolved to.
 */
export interface SeededEntry {
  id: string;
  seq: number;
  authorId: string;
  kind: string;
  body: { text: string; notice?: string; subjectAuthorId?: string };
  mentions: string[];
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
 * Every agent in a room test is `silent`, whatever the room kind — as its
 * manifest default, which is what seeds a DIRECT MESSAGE membership, and again
 * on the membership itself for a channel, which does not read the manifest at
 * all ({@link RoomsApi.silenceAgents}).
 *
 * Posting into a seeded room on the default runtime would otherwise trigger a
 * real agent turn, which is neither fast nor deterministic and costs money.
 * Nothing in this suite is about an agent replying, so nothing here asks one to.
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

  /**
   * This instance's own directory under {@link FIXTURE_AGENT_ROOT}.
   *
   * One root per instance means {@link RoomsApi.cleanup} removes the whole tree
   * in a single call and cannot miss a subdirectory the server added, and it
   * makes this run's namespace (`run-<runId>`) distinct from every other run's.
   */
  private readonly agentRoot = join(FIXTURE_AGENT_ROOT, `run-${this.runId}`);

  constructor(request: APIRequestContext) {
    this.request = request;
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
   * @param options - `runtime` seeds an agent on a runtime other than Claude
   *   Code. Grouping is offered by data volume — eight agents, or two distinct
   *   runtimes (BC-32) — so a spec about groups needs a way to reach the bar
   *   without registering eight of them.
   */
  async registerAgent(
    name: string,
    emoji: string,
    color: string,
    options: { runtime?: string } = {}
  ): Promise<SeededAgent> {
    const path = join(this.agentRoot, `room-agent-${randomUUID()}`);
    // Make the tree ours before the server writes into it, so both paths below
    // resolve through the same real directory rather than one of them being
    // resolved speculatively while it still does not exist.
    await mkdir(path, { recursive: true });
    const res = await this.request.post('/api/mesh/agents', {
      data: {
        path,
        // Without this the server derives the namespace against its own default
        // scan root, which is fine only while the agents live under it. Naming
        // the root keeps the namespace `run-<runId>` wherever the checkout is.
        scanRoot: FIXTURE_AGENT_ROOT,
        overrides: {
          name,
          runtime: options.runtime ?? 'claude-code',
          icon: emoji,
          color,
          behavior: SILENT,
        },
      },
    });
    if (!res.ok()) {
      const body = await res.text();
      // A 403 here is always the same thing, and the raw message does not say
      // so: the server refuses agent paths outside `DORKOS_BOUNDARY`, and this
      // root has to be inside it. `playwright.config.ts` points the boundary at
      // the checkout for exactly that reason, so reaching this means something
      // overrode it.
      if (res.status() === 403) {
        throw new Error(
          `Could not register ${name}: the fixtures' root is outside the server's boundary.\n` +
            `  root:     ${FIXTURE_AGENT_ROOT}\n` +
            `  response: ${body}\n` +
            `Set DORKOS_BOUNDARY to a directory containing that root (the cockpit ` +
            `leg in playwright.config.ts sets it to the checkout).`
        );
      }
      throw new Error(`Could not register ${name}: ${body}`);
    }
    const { id } = (await res.json()) as { id: string };
    this.agentIds.push(id);
    // The register response is the manifest, which deliberately carries no
    // `projectPath` — only the registry listing does.
    const paths = await this.request.get('/api/mesh/agents/paths');
    if (!paths.ok()) throw new Error(`Could not read agent paths: ${await paths.text()}`);
    const { agents } = (await paths.json()) as { agents: { id: string; projectPath: string }[] };
    const projectPath = agents.find((a) => a.id === id)?.projectPath;
    if (!projectPath) throw new Error(`Registered ${name} as ${id} but it has no stored path`);
    return { id, path, projectPath, name, emoji };
  }

  /**
   * Create a channel, naming its `#slug` outright rather than letting the server
   * derive one, so the tests assert a string they chose.
   *
   * @param slug - The channel's `#name`, which must be unique among live channels.
   * @param title - Its display title. Defaults to the slug.
   * @param agents - Agents to seed onto the roster, for a test that needs a
   *   channel with somebody in it. Every one of them is silenced immediately
   *   after the room exists — see {@link RoomsApi.silenceAgents}.
   */
  async createChannel(slug: string, title = slug, agents: SeededAgent[] = []): Promise<SeededRoom> {
    const room = await this.createRoom({
      kind: 'channel',
      slug,
      title,
      agentPaths: agents.map((a) => a.path),
    });
    await this.silenceAgents(room, agents.length);
    return room;
  }

  /**
   * Set every agent member of a room to `silent`, so nothing in this suite can
   * start a turn.
   *
   * **A channel does not read the manifest, which is why this exists.** The
   * manifest `silent` that {@link RoomsApi.registerAgent} writes only seeds a
   * DIRECT MESSAGE membership; a channel seeds every agent to the channel
   * default, which is `engaged` (room-participation spec §9.4). So a spec that
   * types an `@mention` — and one of them does, deliberately — would otherwise
   * ask a real runtime for a real turn, which is neither fast nor free.
   *
   * Stated as a fixture guarantee rather than left resting on whatever the
   * shipped default happens to be: this suite runs with no API key, and a
   * default it does not control is not something it should be betting on.
   *
   * **It counts, and throws when the count is wrong.** A silencer that quietly
   * does nothing is worse than no silencer: the suite goes on believing agents
   * cannot answer, and the way that failure shows up is a real runtime taking a
   * real turn and spending real money. So a roster shape this did not expect —
   * a create that dropped an agent, a response shape that changed — is loud
   * here rather than expensive later.
   *
   * @param room - The room whose roster to quieten.
   * @param expected - How many agent memberships the caller asked for.
   */
  private async silenceAgents(room: SeededRoom, expected: number): Promise<void> {
    const agents = room.members.filter((member) => member.author.kind === 'agent');
    if (agents.length !== expected) {
      throw new Error(
        `Seeded ${expected} agent(s) into ${room.id} but its roster came back with ` +
          `${agents.length}: [${room.members.map((m) => `${m.author.kind}:${m.author.displayName}`).join(', ')}]. ` +
          `Nothing was silenced, so a turn here would reach a real runtime.`
      );
    }
    for (const member of agents) {
      const res = await this.request.patch(`/api/rooms/${room.id}/members/${member.author.id}`, {
        data: SILENT,
      });
      if (!res.ok()) {
        throw new Error(`Could not silence ${member.author.displayName}: ${await res.text()}`);
      }
    }
  }

  /**
   * Read a room's entries back, including the author ids each one resolved its
   * `@mentions` to.
   *
   * The resolved list is the only place a mention's EFFECT is visible: the text
   * looks the same whether it addressed somebody or posted as plain prose.
   *
   * **This is the newest PAGE, not the whole room** — the route serves 50 by
   * default. Sound here only because every room this fixture seeds is created by
   * one test and archived at the end of it, so it never approaches the window.
   * A caller reading a long-lived room needs the paginated walk
   * `TeamRoomApi.entries` does, and the reason is written out there: a truncated
   * page is a valid answer that looks exactly like the room, so the failure is
   * silent (DOR-1213).
   *
   * @param roomId - The room to read.
   */
  async listEntries(roomId: string): Promise<SeededEntry[]> {
    const res = await this.request.get(`/api/rooms/${roomId}/entries`);
    if (!res.ok()) throw new Error(`Could not read entries of ${roomId}: ${await res.text()}`);
    const { entries } = (await res.json()) as { entries: SeededEntry[] };
    return entries;
  }

  /**
   * Wait until a room holds an entry matching `predicate`, and answer with every
   * entry as it stood then.
   *
   * A poll rather than a fixed wait, for the reason `POST /entries` gives: it
   * answers **202**, and an agent's reply lands whenever its turn ends, so there
   * is no moment to sleep until. The twin of `TeamRoomApi.waitForEntry`, which
   * exists there because #team is a room no test may create; this one is for the
   * rooms a test seeds itself.
   *
   * @param roomId - The room to watch.
   * @param predicate - What the awaited entry looks like.
   * @param what - Named in the timeout message, so a failure says what never came.
   */
  async waitForEntry(
    roomId: string,
    predicate: (entry: SeededEntry) => boolean,
    what: string
  ): Promise<SeededEntry[]> {
    const deadline = Date.now() + SERVER_ROUND_TRIP_MS;
    for (;;) {
      const entries = await this.listEntries(roomId);
      if (entries.some(predicate)) return entries;
      if (Date.now() > deadline) {
        throw new Error(
          `Room ${roomId} never got ${what}. It holds ${entries.length} entries: ` +
            entries.map((e) => `${e.authorId.slice(-6)}:${e.body.text ?? ''}`).join(' | ')
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Set one room membership's response mode.
   *
   * The counterpart to {@link RoomsApi.silenceAgents}, and deliberately NOT
   * folded into it: silence is this fixture's standing guarantee, and a caller
   * that wants an agent to answer has to say so in its own file, where the
   * safety argument for doing it can be read next to the test that needs it. A
   * spec that calls this on the cockpit leg is asking a real model for a real
   * turn.
   *
   * @param roomId - The room the membership is in.
   * @param authorId - Whose seat to change.
   * @param responseMode - What it should answer.
   */
  async setResponseMode(roomId: string, authorId: string, responseMode: string): Promise<void> {
    const res = await this.request.patch(`/api/rooms/${roomId}/members/${authorId}`, {
      data: { responseMode },
    });
    if (!res.ok()) {
      throw new Error(`Could not set ${authorId} to ${responseMode}: ${await res.text()}`);
    }
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
   * Post entries into a room as the local human, oldest first, and return once
   * they can be read back.
   *
   * Sequential rather than concurrent: `seq` is allocated per room and the tests
   * assert on the resulting order.
   *
   * The wait at the end is the point. `POST /entries` is trigger-only and
   * answers **202** — accepted, not yet stored — so returning on the last 202
   * hands back a room whose entries may not exist yet. Every caller then loads
   * the cockpit, whose first read of the room list is the one that decides the
   * unread badge and the palette's ordering; if it wins that race, the room
   * reads as having nothing in it, and the test fails describing an unread count
   * rather than a race. Polling here rather than in each spec keeps
   * "seed, then load" true for everyone.
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

    const deadline = Date.now() + SERVER_ROUND_TRIP_MS;
    for (;;) {
      const entries = await this.listEntries(roomId);
      if (entries.length >= texts.length) return;
      if (Date.now() > deadline) {
        throw new Error(
          `Posted ${texts.length} entries to ${roomId} but only ${entries.length} were stored`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Reply inside a thread through the API — the way another reader would.
   *
   * A separate route from {@link RoomsApi.postEntries} because writing into a
   * thread is a separate route in the product (`POST /:id/threads`): the target
   * is required rather than an omitted parameter. Same 202-then-poll shape for
   * the same reason — the reply is accepted, not yet stored, and a caller that
   * loads the cockpit on the 202 races its own seed.
   *
   * Returns the reply's own id, which is the only handle a caller has on it: a
   * thread reply is not in the room's top-level flow, so `entryIds` order alone
   * cannot name it, and presence claims are keyed on exactly this id.
   *
   * @param roomId - The room the thread lives in.
   * @param rootEntryId - The entry heading the thread.
   * @param text - What the reply says.
   */
  async postThreadReply(roomId: string, rootEntryId: string, text: string): Promise<string> {
    const res = await this.request.post(`/api/rooms/${roomId}/threads`, {
      data: { rootEntryId, text },
    });
    if (res.status() !== 202) {
      throw new Error(`Replying in ${rootEntryId} answered ${res.status()}: ${await res.text()}`);
    }
    const { entryId } = (await res.json()) as { entryId: string };

    const deadline = Date.now() + SERVER_ROUND_TRIP_MS;
    for (;;) {
      if ((await this.entryIds(roomId)).includes(entryId)) return entryId;
      if (Date.now() > deadline) throw new Error(`Reply ${entryId} was accepted but never stored`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * The ids of a room's entries, oldest first — what a reaction attaches to.
   *
   * @param roomId - The room to read.
   */
  async entryIds(roomId: string): Promise<string[]> {
    const res = await this.request.get(`/api/rooms/${roomId}/entries`);
    if (!res.ok()) throw new Error(`Reading ${roomId} answered ${res.status()}`);
    const body = (await res.json()) as { entries: { id: string }[] };
    return body.entries.map((entry) => entry.id);
  }

  /**
   * Put an emoji on an entry through the API — the way another reader would.
   *
   * `on` is named rather than flipped, for the same reason the cockpit names it:
   * a seed that flipped would undo itself if it ever ran twice.
   *
   * @param roomId - The room the entry lives in.
   * @param entryId - The entry to react to.
   * @param emoji - The reaction.
   * @param on - The state to land in. Defaults to putting it there.
   */
  async react(roomId: string, entryId: string, emoji: string, on = true): Promise<void> {
    const res = await this.request.post(`/api/rooms/${roomId}/entries/${entryId}/reactions`, {
      data: { emoji, on },
    });
    if (res.status() !== 202) {
      throw new Error(`Reacting on ${entryId} answered ${res.status()}: ${await res.text()}`);
    }
  }

  /**
   * One entry's reaction set, as the SERVER holds it.
   *
   * The check an optimistic pill cannot pass by being drawn: this reads the same
   * history route every reader hydrates from, so what it answers is what the
   * write actually did.
   *
   * @param roomId - The room the entry lives in.
   * @param entryId - The entry to read.
   */
  async reactionsOn(
    roomId: string,
    entryId: string
  ): Promise<{ emoji: string; authorIds: string[] }[]> {
    const res = await this.request.get(`/api/rooms/${roomId}/entries`);
    if (!res.ok()) throw new Error(`Reading ${roomId} answered ${res.status()}`);
    const body = (await res.json()) as {
      entries: { id: string; reactions?: { emoji: string; authorIds: string[] }[] }[];
    };
    return body.entries.find((entry) => entry.id === entryId)?.reactions ?? [];
  }

  /**
   * Wait until the room list reports a room as carrying `count` unread.
   *
   * A test about the unread badge has two preconditions, not one: the entries
   * must be stored, which {@link RoomsApi.postEntries} guarantees, and the room
   * *list* must have caught up — and that is a separate projection, read by a
   * separate endpoint, which is the one the sidebar actually renders from. A
   * page loaded in between sees the room with nothing in it and the badge never
   * appears, which reads as "unread is broken" rather than "the page was early".
   *
   * Polling the same endpoint the sidebar uses turns that race into a
   * precondition: if the count never arrives, this says so in those words
   * instead of leaving an assertion about a screen reader's output to explain it.
   *
   * @param roomId - The room to watch.
   * @param count - The unread count to wait for.
   */
  async waitForUnread(roomId: string, count: number): Promise<void> {
    const deadline = Date.now() + SERVER_ROUND_TRIP_MS;
    let seen: number | null | undefined;
    for (;;) {
      const res = await this.request.get('/api/rooms');
      if (res.ok()) {
        const { rooms } = (await res.json()) as {
          rooms: { id: string; unreadCount: number | null }[];
        };
        seen = rooms.find((r) => r.id === roomId)?.unreadCount;
        if (seen === count) return;
      }
      if (Date.now() > deadline) {
        throw new Error(`Room ${roomId} reports ${seen ?? 'no'} unread, expected ${count}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
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
   * Archive a room now, rather than at teardown.
   *
   * Archiving is the product's read-only state — the room stays open and
   * readable and its composer stays on screen, but nothing new may be added.
   * That makes it the one refusal a browser test can seed outright, which is
   * why it is offered here and not left to {@link RoomsApi.cleanup}.
   *
   * Still tracked for teardown; archiving twice is a no-op.
   *
   * @param roomId - The room to archive.
   */
  async archive(roomId: string): Promise<void> {
    const res = await this.request.patch(`/api/rooms/${roomId}`, { data: { archived: true } });
    if (!res.ok()) throw new Error(`Could not archive room ${roomId}: ${await res.text()}`);
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
   * Archive every room this instance made, unregister every agent, and delete
   * the agent directories off disk.
   *
   * Unregistering only removes the agent from the mesh; the directory the
   * server created stays. So the last step removes this instance's whole
   * {@link RoomsApi.agentRoot}, which is the only thing that keeps a long-lived
   * machine from silently collecting one directory per seeded agent forever.
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
    await rm(this.agentRoot, { recursive: true, force: true }).catch(() => {});
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
