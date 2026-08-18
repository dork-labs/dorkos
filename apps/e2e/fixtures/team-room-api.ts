/**
 * Server-side setup and teardown for the #team home surface tests.
 *
 * #team is not a room a test may create: the server opens exactly one per
 * install at boot and refuses to let anything delete it (spec `team-room-home`
 * D3.1). So unlike {@link RoomsApi}, which seeds a fresh room per test, this
 * helper works against the room that is already there — and every write it makes
 * to it has to be undone, because the next test to load `/` is looking at the
 * same room.
 *
 * Everything here goes through the same REST API the cockpit uses, for the same
 * reason `rooms-api.ts` gives: a test about how home RENDERS should fail when
 * the rendering breaks, not when a create flow does.
 *
 * @module fixtures/team-room-api
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

/**
 * Where this helper's agents live — inside the repo's gitignored `.temp`, and
 * inside the server's boundary by construction.
 *
 * The same three constraints `rooms-api.ts` enumerates apply unchanged
 * (in-bounds to register, in-bounds to delete, ours to sweep), so the reasoning
 * is not repeated here — read that module's `FIXTURE_AGENT_ROOT` for it.
 */
const TEAM_AGENT_ROOT = join(import.meta.dirname, '..', '.temp', 'team-fixtures');

/**
 * The Shape id every seeded approval names.
 *
 * Seeding a pending approval needs a DESTRUCTIVE effect asked for by something
 * that is not the person in the cockpit, and `POST /api/shapes/:name/apply` is
 * the smallest one reachable over HTTP: it runs the tier gate BEFORE it resolves
 * the Shape, so a name nothing has installed still produces a real approval and
 * still cannot do anything (`routes/shapes.ts`, DOR-625).
 *
 * Two properties make it safe to lean on. The gate refuses a caller that
 * presents an agent identity — resolved or not — so sending a nonsense
 * `X-DorkOS-Agent` is what makes this helper NOT the trusted operator and gets
 * the 202 instead of the effect. And granting the approval only records the
 * decision: the requester never retries with the token, so nothing is ever
 * applied. A granted card here changes exactly one thing, which is the card.
 */
const APPROVAL_PROBE_SHAPE = 'e2e-approval-probe';

/** How long to give a server round trip. Same ceiling, same reasoning, as `rooms-api.ts`. */
export const SERVER_ROUND_TRIP_MS = 30_000;

/**
 * Entries per page when walking #team's history.
 *
 * `ROOM_ENTRY_PAGE_SIZE_MAX` — the largest page the route will serve — so the
 * walk costs the fewest requests.
 */
const ENTRY_PAGE_SIZE = 200;

/**
 * How many pages back {@link TeamRoomApi.entries} will walk before giving up.
 *
 * A guard against a pagination bug looping forever, not a real ceiling: #team on
 * a test leg holds tens of entries, and this allows forty thousand.
 */
const MAX_HISTORY_PAGES = 200;

/** A room as `GET /api/rooms` lists it, in the fields home cares about. */
export interface TeamRoomSummary {
  id: string;
  slug: string | null;
  title: string;
  archived: boolean;
  wellKnown: string | null;
  /** The membership that answers a post nobody addressed (spec D3.4). */
  fallbackSeatAuthorId: string | null;
}

/**
 * The milestone marking on an entry that is one (spec `team-room-home` D5.1).
 *
 * `source` is the half worth asserting on: a moment names the record it was read
 * off, so a test can check the line against the thing that really happened
 * rather than against its own wording.
 */
export interface TeamRoomMoment {
  kind: string;
  source: { kind: string; ref: string; observedAt: string };
  mintedByAgentRef: string | null;
}

/** One entry of the room, as the history route returns it. */
export interface TeamRoomEntry {
  id: string;
  seq: number;
  authorId: string;
  /**
   * The conversation this entry belongs to — a post's own id, and every answer
   * to it.
   *
   * **The only sound way to ask "who answered ME" in #team**, and the reason two
   * tests here were flaky (DOR-1213). Every test on this leg shares this room,
   * and `POST /entries` is trigger-only: a test that asserts its timeline and
   * moves on leaves its agent's reply still coming. That straggler lands during
   * the NEXT test, arrives after that test's `before` snapshot, and is counted
   * as an answer to a message it has nothing to do with — which is how "the
   * default agent answered a post that named somebody else" was reported about a
   * reply to a post two tests earlier.
   *
   * Filtering by id-not-seen-before cannot tell those apart. The cascade can:
   * it is the server's own answer to which conversation a line is part of.
   */
  cascadeRoot: string;
  /**
   * `moment` is what makes an entry a milestone and `notice` is what makes it
   * the ROOM speaking rather than somebody in it — both are ordinary posts whose
   * body says what they are, which is exactly how the cockpit tells them apart
   * too (`RoomMessage`, `NoticeRow`). An assertion about who ANSWERED has
   * to exclude notices, or the room's own helpful line counts as a participant.
   */
  body: { text?: string; notice?: string; moment?: TeamRoomMoment; subjectAuthorId?: string };
  mentions: string[];
}

/** An agent this helper created, as the tests need to refer to it. */
export interface TeamAgent {
  id: string;
  /** The directory the agent was created at, which is how rooms address it. */
  path: string;
  /** Its display name, which is also its `@handle` lowercased. */
  name: string;
}

/**
 * Reads and writes the one #team room, and puts back everything it changed.
 *
 * The archive/restore pair is the sharp edge: while #team is archived, `/`
 * renders the restore notice for EVERY page on this server, so anything that
 * archives it has to restore it in the same test and must not run beside another
 * test that reads home. {@link TeamRoomApi.cleanup} restores it unconditionally
 * as a backstop, but a test that leans on that has already been flaky once.
 */
export class TeamRoomApi {
  private readonly request: APIRequestContext;
  private readonly agentIds: string[] = [];
  private readonly seededApprovalIds: string[] = [];
  private archivedByUs = false;
  /** How many settle markers this instance has posted, so each one is distinct. */
  private settles = 0;

  /** A short id, unique per instance, for naming fixtures apart. */
  readonly runId = randomUUID().slice(0, 8);

  /** This instance's own agent directory, swept whole at teardown. */
  private readonly agentRoot = join(TEAM_AGENT_ROOT, `run-${this.runId}`);

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  /**
   * The #team room, found by its well-known key rather than by its slug.
   *
   * The key is the point: a slug moves with a rename and the cockpit resolves
   * this room the same way (`use-team-room.ts`), so a test that looked it up by
   * `#team` would be asserting against a different lookup than the one shipping.
   */
  async teamRoom(): Promise<TeamRoomSummary> {
    // `includeArchived` always, and that is the whole reason this is not a
    // one-line fetch. An archived room leaves the ordinary list — that is what
    // archiving means — so a plain read reports #team as MISSING the moment a
    // test puts it away, which is exactly when a test most needs to read it.
    // The cockpit resolves it the same way, falling back to an
    // archived-inclusive read when the ordinary list has no #team in it
    // (`use-team-room.ts`).
    const res = await this.request.get('/api/rooms?includeArchived=true');
    if (!res.ok()) throw new Error(`Could not read rooms: ${await res.text()}`);
    const { rooms } = (await res.json()) as { rooms: TeamRoomSummary[] };
    const team = rooms.find((room) => room.wellKnown === 'team');
    if (!team) {
      throw new Error(
        `No room carries the well-known key 'team'. The server opens it at boot ` +
          `(ensureTeamRoom), so this means the boot hook did not run — check the API leg's log.`
      );
    }
    return team;
  }

  /**
   * #team's entries, oldest first — **all of them**, not the newest page.
   *
   * `GET /:id/entries` is paginated: it serves the newest 50 unless asked
   * otherwise, and 200 at most. That default is the right one for a cockpit
   * hydrating a feed and completely wrong for a test asking a question about the
   * room's whole history — and the difference is silent, because a truncated
   * page is a valid answer that looks like the room.
   *
   * It bit exactly that way (DOR-1213). #team is never deleted, so on a
   * `--repeat-each` run its history grows past 50, and the moment marked on the
   * first pass fell off the back of the window. `moments()` reads this, so the
   * moments test saw an empty list, concluded it had never run, declined to
   * skip, and then failed waiting for a milestone the hour-long quiet period was
   * correctly suppressing. Every count in this file has the same exposure.
   *
   * So this walks the pages back to the beginning. The cap is a guard against a
   * pagination bug turning a test into an infinite loop, not a limit anybody is
   * expected to reach.
   */
  async entries(): Promise<TeamRoomEntry[]> {
    const { id } = await this.teamRoom();
    const all: TeamRoomEntry[] = [];
    let before: number | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const query = `limit=${ENTRY_PAGE_SIZE}${before === undefined ? '' : `&before=${before}`}`;
      const res = await this.request.get(`/api/rooms/${id}/entries?${query}`);
      if (!res.ok()) throw new Error(`Could not read #team: ${await res.text()}`);
      const { entries } = (await res.json()) as { entries: TeamRoomEntry[] };
      all.unshift(...entries);
      if (entries.length < ENTRY_PAGE_SIZE) return all;
      before = entries[0]!.seq;
    }
    throw new Error(
      `#team holds more than ${MAX_HISTORY_PAGES * ENTRY_PAGE_SIZE} entries, or its ` +
        `pagination is not advancing. Either way this read cannot answer a question ` +
        `about the whole room.`
    );
  }

  /**
   * The entries of #team that are milestones, oldest first.
   *
   * The filter is `body.moment`, which is the server's own tell and the
   * cockpit's: a moment is an ordinary post whose body says what it marks, so
   * there is no separate feed to read and no `kind` to match on.
   */
  async moments(): Promise<TeamRoomEntry[]> {
    return (await this.entries()).filter((entry) => entry.body.moment !== undefined);
  }

  /**
   * How far this person has read #team, or `null` when they never have.
   *
   * The barrier the quiet-state test waits on. "Caught up" is measured against
   * the cursor as it stood when the page opened, so a test that reloaded before
   * the first visit's cursor had been written would be asserting on a page that
   * is correctly still showing a conversation.
   */
  async readCursorSeq(): Promise<number | null> {
    const { id } = await this.teamRoom();
    const res = await this.request.get(`/api/read-cursors/room/${id}`);
    if (!res.ok()) throw new Error(`Could not read the #team cursor: ${await res.text()}`);
    const { cursor } = (await res.json()) as { cursor: { lastReadSeq: number } | null };
    return cursor?.lastReadSeq ?? null;
  }

  /** How many agents this install has registered, as the cockpit counts them. */
  async registeredAgentCount(): Promise<number> {
    const res = await this.request.get('/api/mesh/agents');
    if (!res.ok()) throw new Error(`Could not read the agent list: ${await res.text()}`);
    const { agents } = (await res.json()) as { agents: unknown[] };
    return agents.length;
  }

  /**
   * How many agents the mesh cannot reach.
   *
   * Read by the quiet-state test as a precondition rather than asserted on: an
   * unreachable agent puts a row in the pinned triage header, and the header
   * having something to say is precisely when the quiet line stands down. A
   * test that did not check this first would fail with "no quiet line" on a
   * server that was correctly refusing to draw one.
   */
  async meshUnreachableCount(): Promise<number> {
    const res = await this.request.get('/api/mesh/status');
    if (!res.ok()) throw new Error(`Could not read mesh status: ${await res.text()}`);
    const { unreachableCount } = (await res.json()) as { unreachableCount?: number };
    return unreachableCount ?? 0;
  }

  /**
   * Wait until #team holds an entry matching `predicate`, and answer with every
   * entry as it stood then.
   *
   * A poll rather than a fixed wait: `POST /entries` answers 202 and an agent's
   * reply arrives whenever its turn ends, so there is no moment to sleep until.
   *
   * @param predicate - What the awaited entry looks like.
   * @param what - Named in the timeout message, so a failure says what never came.
   */
  async waitForEntry(
    predicate: (entry: TeamRoomEntry) => boolean,
    what: string
  ): Promise<TeamRoomEntry[]> {
    const deadline = Date.now() + SERVER_ROUND_TRIP_MS;
    for (;;) {
      const entries = await this.entries();
      if (entries.some(predicate)) return entries;
      if (Date.now() > deadline) {
        throw new Error(
          `#team never got ${what}. It holds ${entries.length} entries: ` +
            entries.map((e) => `${e.authorId.slice(-6)}:${e.body.text ?? ''}`).join(' | ')
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Create an agent through the route the cockpit's own "Add agent" uses, which
   * is also the route that seats it in #team.
   *
   * **Deliberately `POST /api/agents` and not `POST /api/mesh/agents`.** Only the
   * former notifies the `agent-created` seam that calls `joinTeamRoom`, so only
   * the former puts the new agent in the room without a restart. See this file's
   * spec for the note about the other route.
   *
   * @param name - Display name, which is also the `@handle` a mention uses.
   */
  async createAgent(name: string): Promise<TeamAgent> {
    const path = join(this.agentRoot, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    await mkdir(path, { recursive: true });
    const res = await this.request.post('/api/agents', {
      data: { path, name, runtime: 'claude-code' },
    });
    if (!res.ok()) {
      // A 403 is always the boundary — see `rooms-api.ts`'s registerAgent for
      // the full explanation and the fix.
      throw new Error(`Could not create ${name} (${res.status()}): ${await res.text()}`);
    }
    const { id } = (await res.json()) as { id: string };
    this.agentIds.push(id);
    return { id, path, name };
  }

  /**
   * Wait until an agent is on #team's roster **and answers to an `@handle`**,
   * and answer with its author id.
   *
   * Two seams, not one, and waiting on only the first is what made
   * "naming an agent stands the default agent down" flaky (DOR-1213). Seating
   * runs after the creation response, so reading the roster straight away races
   * it — that much was already handled. But a seat is addressable only once its
   * handle is in the roster's projection, and `@name` in a composer is plain
   * text until the server resolves it: post one message too early and the
   * mention resolves to NOBODY, the fallback seat correctly answers an
   * unaddressed post, and the test fails saying the default agent piled on. The
   * product was right and the setup was early.
   *
   * `author.handle` is the roster's own answer to "can this member be
   * addressed" — `null` means it cannot (`room-roster.ts`) — so waiting for it
   * to be non-null is waiting for exactly the thing a mention needs.
   *
   * @param name - The display name to look for.
   */
  async waitForMember(name: string): Promise<string> {
    const { id } = await this.teamRoom();
    const deadline = Date.now() + SERVER_ROUND_TRIP_MS;
    let seen: string | null | undefined;
    for (;;) {
      const res = await this.request.get(`/api/rooms/${id}`);
      if (res.ok()) {
        const { members } = (await res.json()) as {
          members: { author: { id: string; displayName: string; handle?: string | null } }[];
        };
        const seat = members.find((member) => member.author.displayName === name);
        seen = seat?.author.handle;
        if (seat && seat.author.handle) return seat.author.id;
      }
      if (Date.now() > deadline) {
        throw new Error(
          seen === undefined
            ? `${name} never joined #team`
            : `${name} joined #team but never became addressable — its roster row still carries no @handle`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Ask for something destructive as a machine, so a real approval card appears.
   *
   * @returns The approval's id, so a test can assert it left the queue.
   */
  async seedApproval(): Promise<string> {
    const name = `${APPROVAL_PROBE_SHAPE}-${this.runId}-${this.seededApprovalIds.length}`;
    const res = await this.request.post(`/api/shapes/${name}/apply`, {
      // Presenting ANY agent identity is what makes this caller not the
      // operator; it never has to resolve. See APPROVAL_PROBE_SHAPE.
      headers: { 'X-DorkOS-Agent': `e2e-${this.runId}` },
      data: {},
    });
    if (res.status() !== 202) {
      throw new Error(
        `Seeding an approval answered ${res.status()} instead of 202: ${await res.text()}. ` +
          `A 200 means the gate treated this caller as the operator, which the ` +
          `X-DorkOS-Agent header is there to prevent.`
      );
    }
    const { approvalId } = (await res.json()) as { approvalId: string };
    this.seededApprovalIds.push(approvalId);
    return approvalId;
  }

  /** The ids still waiting on a person. */
  async pendingApprovalIds(): Promise<string[]> {
    const res = await this.request.get('/api/approvals/pending');
    if (!res.ok()) throw new Error(`Could not read approvals: ${await res.text()}`);
    const { approvals } = (await res.json()) as { approvals: { approvalId: string }[] };
    return approvals.map((approval) => approval.approvalId);
  }

  /**
   * The display names of every #team member set to answer EVERYTHING (`always`).
   *
   * A precondition, not an assertion target. "Typing here reaches your default
   * agent and nobody else piles on" is a claim about a room with ONE such seat —
   * with two, two agents answering an unaddressed post is the product working,
   * and the test would be reporting correct behaviour as a regression.
   *
   * The seat moves (`syncDefaultAgent` re-points it whenever an agent is
   * created), so on a leg where tests have been creating and deleting agents —
   * every repeat of this file does — more than one membership can end up
   * holding it. Reading it is how the test tells "this leg has drifted" from
   * "the product piled on".
   */
  async seatsThatAnswerEverything(): Promise<string[]> {
    return (await this.agentSeats())
      .filter((seat) => seat.responseMode === 'always')
      .map((seat) => seat.name);
  }

  /**
   * Every agent on #team's roster with the mode it answers in — the whole
   * picture, for a failure message that has to say what the room looked like.
   */
  async roster(): Promise<string[]> {
    return (await this.agentSeats()).map((seat) => `${seat.name}:${seat.responseMode}`);
  }

  /** #team's agent memberships, as `GET /api/rooms/:id` returns them. */
  private async agentSeats(): Promise<{ name: string; responseMode: string }[]> {
    const { id } = await this.teamRoom();
    const res = await this.request.get(`/api/rooms/${id}`);
    if (!res.ok()) throw new Error(`Could not read #team's roster: ${await res.text()}`);
    const { members } = (await res.json()) as {
      members: { responseMode?: string; author: { kind: string; displayName: string } }[];
    };
    return members
      .filter((member) => member.author.kind === 'agent')
      .map((member) => ({
        name: member.author.displayName,
        responseMode: member.responseMode ?? 'unknown',
      }));
  }

  /**
   * Post into #team as the local person — the same route the composer's Enter
   * reaches.
   *
   * @param text - What to say.
   */
  async post(text: string): Promise<void> {
    const { id } = await this.teamRoom();
    const res = await this.request.post(`/api/rooms/${id}/entries`, { data: { text } });
    if (res.status() !== 202) {
      throw new Error(`Posting to #team answered ${res.status()}: ${await res.text()}`);
    }
  }

  /**
   * How many agents are working in #team right now, as the room list reports it.
   *
   * The same live read of the claim map the cockpit's own working indicator
   * uses (`use-room-working.ts`), which makes it the one honest answer to "has
   * everything this room was doing finished".
   */
  async workingCount(): Promise<number> {
    const { id } = await this.teamRoom();
    const res = await this.request.get('/api/rooms');
    if (!res.ok()) throw new Error(`Could not read the room list: ${await res.text()}`);
    const { rooms } = (await res.json()) as { rooms: { id: string; working?: number }[] };
    return rooms.find((room) => room.id === id)?.working ?? 0;
  }

  /**
   * Wait until #team has finished everything it was doing.
   *
   * **Why counting answers needs this at all.** An assertion of the form "only
   * one agent answered" is read off a snapshot, and a snapshot taken the instant
   * the FIRST answer lands cannot see a second one that is still being written.
   * Such a test does not fail when a second agent piles on — it passes, because
   * it looked too early. That is the same "settle before you count" problem
   * `tests/rooms/room-autonomy.spec.ts` solves for a burst, and this is the
   * #team-shaped version of it.
   *
   * Two barriers, because one is not enough. A marker message that gets its OWN
   * answer proves the room has processed something posted LATER than the message
   * under test — but only for the agent that answered it. So the working count
   * is then read down to zero, which is a claim about every agent: nothing in
   * this room still holds a claim, so nothing else is coming.
   */
  async settle(): Promise<void> {
    const marker = `settle ${this.runId}-${this.settles++}`;
    const before = await this.entries();
    await this.post(marker);
    const posted = await this.waitForEntry(
      (entry) => entry.body.text === marker && !before.some((e) => e.id === entry.id),
      `the settle marker "${marker}" to be stored`
    );
    const root = posted.find((entry) => entry.body.text === marker)!.cascadeRoot;
    await this.waitForEntry(
      (entry) =>
        entry.cascadeRoot === root && entry.body.text !== marker && entry.body.notice === undefined,
      `an answer to the settle marker "${marker}"`
    );

    const deadline = Date.now() + SERVER_ROUND_TRIP_MS;
    for (;;) {
      const working = await this.workingCount();
      if (working === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`#team still reports ${working} agent(s) working after a full settle`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Put #team away, the way its owner can. Restored by {@link TeamRoomApi.cleanup}. */
  async archiveTeamRoom(): Promise<void> {
    const { id } = await this.teamRoom();
    const res = await this.request.patch(`/api/rooms/${id}`, { data: { archived: true } });
    if (!res.ok()) throw new Error(`Could not archive #team: ${await res.text()}`);
    this.archivedByUs = true;
  }

  /** Whether #team is currently archived, as the server sees it. */
  async isArchived(): Promise<boolean> {
    return (await this.teamRoom()).archived;
  }

  /**
   * Undo everything: restore #team, deny every approval this instance opened,
   * unregister its agents and sweep their directories.
   *
   * Failures are swallowed for the reason `rooms-api.ts` gives — teardown runs
   * after the verdict, and a cleanup error reported as a failure hides the real
   * one. Restoring the room is the exception worth naming: it is the only thing
   * here that another test can see.
   */
  async cleanup(): Promise<void> {
    if (this.archivedByUs) {
      const team = await this.teamRoom().catch(() => null);
      if (team?.archived) {
        await this.request
          .patch(`/api/rooms/${team.id}`, { data: { archived: false } })
          .catch(() => {});
      }
    }
    for (const approvalId of this.seededApprovalIds) {
      await this.request
        .post(`/api/approvals/${approvalId}/deny`, { data: { reason: 'e2e teardown' } })
        .catch(() => {});
    }
    for (const id of this.agentIds) {
      await this.request.delete(`/api/mesh/agents/${id}/data`).catch(() => {});
    }
    await rm(this.agentRoot, { recursive: true, force: true }).catch(() => {});
  }
}
