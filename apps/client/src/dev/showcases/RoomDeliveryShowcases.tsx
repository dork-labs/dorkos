/**
 * The room rows nobody can produce on demand — DOR-783, and the moments that
 * joined them (team-room-home D5.1).
 *
 * Every state here needs the world to cooperate. A notice needs an agent to
 * actually fail, be busy, or run a room out of budget; a pending row needs a
 * slow link or a dead stream; a moment needs a first pull request or a
 * hundredth session. They are also exactly the states that regress unseen: they
 * are rare, so nobody looks.
 *
 * The REAL components, never a copy of their markup — the notice's tone and mark
 * are chosen inside `NoticeRow`, and the pending row's two states are chosen
 * inside `PendingRow`, so a recreation would be the one thing incapable of
 * showing that either choice had drifted.
 *
 * @module dev/showcases/RoomDeliveryShowcases
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoomAttachment, RoomMoment, RoomNoticeCode } from '@dorkos/shared/room-schemas';
import type { PendingPost, RoomEntry } from '@/layers/entities/room';
import { Conversation, Message, PendingRow } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES, RoomMessage } from '@/layers/widgets/room-view';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { THREAD_AGENT_ANA, THREAD_AGENT_KAI, THREAD_ROOM_ID } from './room-thread-showcase-data';

/**
 * Every notice the room can write, with the SERVER's own words.
 *
 * Copied from `rooms/notices/notice-copy.ts` rather than paraphrased: the point of the bench
 * is to show what a person actually reads, and prose written for a playground
 * would flatter a layout that real sentences would break.
 */
const NOTICES: ReadonlyArray<{ code: RoomNoticeCode; text: string; label: string }> = [
  {
    code: 'turn_failed',
    label: 'turn_failed — warm, because the answer is not coming',
    text: "Kai ran into a problem and could not answer here. Open Kai's session to see what went wrong.",
  },
  {
    code: 'awaiting_approval',
    label: 'awaiting_approval — warm, because it is waiting on YOU',
    text: "Kai is waiting for you to approve something before it can carry on. Open Kai's session to answer. It will wait, but not forever.",
  },
  {
    code: 'agent_busy',
    label: 'agent_busy — occupied, not broken',
    text: 'Kai was busy with something else and did not pick this up. Send it again when Kai is free.',
  },
  {
    code: 'halted',
    label: 'halted — somebody pressed Stop',
    text: 'Everything here was stopped. 2 agents were working and have been interrupted; send a message to start again.',
  },
  {
    code: 'cascade_stopped',
    label: 'cascade_stopped — the back-and-forth hit its limit',
    text: 'Kai stopped replying here. This back-and-forth hit its automatic-reply limit. Send a message to pick it back up.',
  },
  {
    code: 'budget_reached',
    label: 'budget_reached — the room hit its cap for the hour',
    text: 'This room has used up its automatic replies for the hour. It will pick up again shortly, or raise the limit in Settings if this room is meant to be this busy.',
  },
  {
    code: 'addressing_changed',
    label: 'addressing_changed — DorkOS changed who answers',
    text: 'DorkOS changed when the agents in this room answer. They now reply to everything said here, not only when named.',
  },
];

/**
 * Every kind of moment, with the shape of sentence each one really writes.
 *
 * The words are the point of the bench. A moment is only ever derived from
 * something that happened (spec D5.1), so the lines here are the plain ones a
 * detector can honestly write — "tangerines joined your team", never
 * "🎉 New team member onboarded!". Read them together and check that a column of
 * them still reads as a calm feed rather than a wall of celebration.
 */
const MOMENTS: ReadonlyArray<{
  moment: RoomMoment;
  text: string;
  label: string;
  /** Who it is about, when the room is speaking about somebody. */
  subjectAuthorId?: string;
  /** Who WROTE it — the system voice unless an agent minted it. */
  authorId?: string;
}> = [
  {
    label: 'joined_team — the canonical one, written by DorkOS about an agent',
    moment: {
      kind: 'joined_team',
      source: { kind: 'agent', ref: '/agents/kai', observedAt: '2026-08-08T09:12:00.000Z' },
      mintedByAgentRef: null,
    },
    subjectAuthorId: THREAD_AGENT_KAI.id,
    text: 'Kai joined your team.',
  },
  {
    label: 'first_pr — a first, and it only ever fires once',
    moment: {
      kind: 'first_pr',
      source: {
        kind: 'pull_request',
        ref: 'https://github.com/dork-labs/example/pull/1',
        observedAt: '2026-08-08T11:40:00.000Z',
      },
      mintedByAgentRef: null,
    },
    subjectAuthorId: THREAD_AGENT_KAI.id,
    text: 'Kai opened your first pull request.',
  },
  {
    label: 'volume_mark — a real number, counted, never rounded up',
    moment: {
      kind: 'volume_mark',
      source: { kind: 'activity', ref: 'week-2026-W32', observedAt: '2026-08-08T18:00:00.000Z' },
      mintedByAgentRef: null,
    },
    text: 'Your agents shipped something every day this week.',
  },
  {
    label: 'anniversary — a long line, to check the band wraps',
    moment: {
      kind: 'anniversary',
      source: { kind: 'session', ref: 'session-100', observedAt: '2026-08-08T20:05:00.000Z' },
      mintedByAgentRef: null,
    },
    subjectAuthorId: THREAD_AGENT_ANA.id,
    text: 'That was your hundredth session with Ana, one month to the day after the first one.',
  },
  {
    label: 'agent_minted — an agent noticed it, so the agent is the one speaking',
    moment: {
      kind: 'agent_minted',
      source: { kind: 'schedule', ref: 'schedule-nightly', observedAt: '2026-08-09T04:00:00.000Z' },
      mintedByAgentRef: 'ref-kai',
    },
    authorId: THREAD_AGENT_KAI.id,
    text: 'I finished the nightly run — the backlog is empty for the first time.',
  },
];

let momentSeq = 0;

/** One seeded moment, written the way `RoomService.postMoment` writes one. */
function momentEntry(
  moment: RoomMoment,
  text: string,
  subjectAuthorId: string | undefined,
  authorId: string | undefined
): RoomEntry {
  momentSeq += 1;
  const id = `bench-moment-${momentSeq}`;
  return {
    roomId: THREAD_ROOM_ID,
    seq: momentSeq,
    id,
    // A moment DorkOS writes is authored by the system voice; one an agent
    // mints is authored by that agent.
    authorId: authorId ?? 'system',
    // A POST, which is the whole design: nothing downstream had to learn a
    // fourth entry kind.
    kind: 'post',
    body: { text, moment, ...(subjectAuthorId && { subjectAuthorId }) },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 3,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-08-08T09:12:00.000Z',
  };
}

let noticeSeq = 0;

/** One seeded notice, written by the system author the way a real one is. */
function noticeEntry(code: RoomNoticeCode, text: string): RoomEntry {
  noticeSeq += 1;
  const id = `bench-notice-${noticeSeq}`;
  return {
    roomId: THREAD_ROOM_ID,
    seq: noticeSeq,
    id,
    authorId: 'system',
    kind: 'notice',
    body: { text, notice: code, subjectAuthorId: THREAD_AGENT_KAI.id },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T09:40:00.000Z',
  };
}

/**
 * One pending row, with everything the store would have filled in.
 *
 * `at` is the one field a demo has to choose deliberately: a row grows a way out
 * once it has been in flight for `PENDING_SLOW_MS`, so "just sent" has to be
 * genuinely just sent and "taking too long" has to be genuinely old. The
 * just-sent row below therefore does become the slow one after fifteen seconds
 * on this page — which is the behaviour, not a bench artefact.
 */
function pending(status: PendingPost['status'], text: string, at = Date.now()): PendingPost {
  return {
    clientId: `bench-${status}-${at}`,
    roomId: THREAD_ROOM_ID,
    threadRootId: null,
    text,
    attachmentNames: [],
    attachmentIds: [],
    status,
    entryId: null,
    at,
  };
}

/** The room's roster, so a moment can draw the identity it is about. */
const MOMENT_AUTHORS = new Map(
  [THREAD_AGENT_KAI, THREAD_AGENT_ANA].map((author) => [
    author.id,
    { ...author, origin: 'local' as const },
  ])
);

/** Every kind of moment, side by side — the one axis to review the tone on. */
function MomentsSection() {
  return (
    <PlaygroundSection
      title="Room moments"
      description="A milestone the room marks, drawn through the same row as everything else in the feed — because a moment IS a post, carrying `body.moment`. Warm without being loud: the only colour is the identity's own, there is one mark for the whole family rather than one per kind, and nothing moves. Read them together and check that (a) a moment is tellable from a message at a glance, (b) five of them in a column still read as a calm feed and not a party, and (c) the identity beside each one is who the milestone is ABOUT."
    >
      {MOMENTS.map(({ moment, text, label, subjectAuthorId, authorId }) => {
        const entry = momentEntry(moment, text, subjectAuthorId, authorId);
        const subject = MOMENT_AUTHORS.get(subjectAuthorId ?? entry.authorId);
        return (
          <div key={label}>
            <ShowcaseLabel>{label}</ShowcaseLabel>
            <ShowcaseDemo>
              <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
                <RoomMessage
                  roomId={THREAD_ROOM_ID}
                  entry={entry}
                  author={{
                    id: entry.authorId,
                    kind: authorId ? 'agent' : 'system',
                    displayName: subject?.displayName ?? 'DorkOS',
                    ...(subject?.color && { color: subject.color }),
                  }}
                  authorRef={MOMENT_AUTHORS.get(entry.authorId)}
                  authors={MOMENT_AUTHORS}
                  viewerAuthorId="author-you"
                  authorNames={new Map()}
                  reactionFrequents={[]}
                  grouping={{ position: 'only' }}
                />
              </Conversation.Root>
            </ShowcaseDemo>
          </div>
        );
      })}
    </PlaygroundSection>
  );
}

/** Every notice a room writes, side by side — the one axis to review them on. */
function NoticesSection() {
  return (
    <PlaygroundSection
      title="Room notices"
      description="The room speaking in its own voice. Five different things, and until DOR-783 all five drew identically — one italic muted line, with the code read by nothing in the client. Each now carries its own mark, and exactly one carries a tone: turn_failed, the only one of the five where something has gone wrong. Read them together and check that (a) they are tellable apart at a glance, and (b) the other four stay quiet enough that a busy afternoon does not turn into a wall of alarm."
    >
      {NOTICES.map(({ code, text, label }) => (
        <div key={code}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo>
            <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
              <RoomMessage
                roomId={THREAD_ROOM_ID}
                entry={noticeEntry(code, text)}
                author={{ id: 'system', kind: 'system', displayName: 'DorkOS' }}
                authorRef={undefined}
                authors={new Map()}
                viewerAuthorId="author-you"
                authorNames={new Map()}
                reactionFrequents={[]}
                grouping={{ position: 'only' }}
              />
            </Conversation.Root>
          </ShowcaseDemo>
        </div>
      ))}
    </PlaygroundSection>
  );
}

/** A message of your own, in flight and refused. */
function PendingSection() {
  return (
    <PlaygroundSection
      title="PendingRow"
      description="What holds your words between pressing Enter and the room echoing them back. A post is trigger-only — the entry arrives on the room's stream, not in the response — so without this the sentence was simply gone for the length of the round trip, and gone for good under a stream that had stopped listening. In flight it is the same words in the same place, dimmed and with nothing to press; once it has been in flight too long it grows a Discard, because a row with no way out is one that can be stuck on screen for the session; refused, it says so and offers both. Nothing here can lose the words without somebody choosing to."
    >
      <ShowcaseLabel>In flight, just sent</ShowcaseLabel>
      <ShowcaseDemo>
        <PendingRow
          post={pending('sending', 'is the build still stuck?')}
          viewerAuthorId="author-you"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Refused — the words are still here</ShowcaseLabel>
      <ShowcaseDemo>
        <PendingRow
          post={pending('failed', 'is the build still stuck?')}
          viewerAuthorId="author-you"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>In flight too long — a way out appears</ShowcaseLabel>
      <ShowcaseDemo>
        <PendingRow
          post={pending('sending', 'is the build still stuck?', 0)}
          viewerAuthorId="author-you"
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** One attachment as the server answers it, so the bench never invents a shape. */
function attachment(over: Partial<RoomAttachment> & { name: string; id: string }): RoomAttachment {
  return {
    mimeType: 'application/octet-stream',
    size: 48_213,
    preview: null,
    url: `/api/rooms/${THREAD_ROOM_ID}/attachments/${over.id}`,
    ...over,
  };
}

/**
 * A 2x2 PNG, inline, so the thumbnail branch draws real pixels with no network.
 *
 * A `data:` URL rather than a file on disk: the point of the bench is the
 * LAYOUT around an image, and a broken `<img>` would review the wrong thing.
 */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAG0lEQVR42mNk+M9Qz0AEYBxVSF+FAAB5bwIB1lDkxQAAAABJRU5ErkJggg==';

/** The two ways a file can arrive, and what several of them do to the row. */
function AttachmentsSection() {
  return (
    <PlaygroundSection
      title="Message.Attachments"
      description="What a file looks like once it is part of the conversation. Two branches, and which one draws is decided by the SERVER: an image renders inline only when the bytes themselves were checked, and everything else — including a file merely NAMED .png — is a chip you download. Read these together and check that (a) a thumbnail sits under the words without pushing the reaction pills off the bottom of a short message, (b) a chip stays readable when the filename is long enough to truncate, and (c) several files wrap rather than scroll."
    >
      <ShowcaseLabel>Verified image — the only case that renders inline</ShowcaseLabel>
      <ShowcaseDemo>
        <Message.Attachments
          items={[
            attachment({
              id: 'att-image',
              name: 'build-graph.png',
              mimeType: 'image/png',
              preview: 'image',
              size: 184_320,
              url: TINY_PNG,
            }),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Everything else — a chip you can download</ShowcaseLabel>
      <ShowcaseDemo>
        <Message.Attachments
          items={[
            attachment({ id: 'att-log', name: 'server.log', mimeType: 'text/plain', size: 812 }),
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Several at once, one of them named to look like an image</ShowcaseLabel>
      <ShowcaseDemo>
        <Message.Attachments
          items={[
            attachment({
              id: 'att-shot',
              name: 'screenshot.png',
              mimeType: 'image/png',
              preview: 'image',
              size: 184_320,
              url: TINY_PNG,
            }),
            attachment({
              id: 'att-notes',
              name: 'a-filename-long-enough-to-truncate-in-the-chip.pdf',
              mimeType: 'application/pdf',
              size: 2_411_724,
            }),
            attachment({
              id: 'att-liar',
              name: 'not-really.png',
              // Declared an image, and `preview` is still null because the bytes
              // were not one. This is the GIF-in-a-.png case, and it must draw
              // as a chip.
              mimeType: 'image/png',
              size: 4_096,
            }),
          ]}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Moments, notices and pending sends — the rows a real room only rarely shows.
 *
 * Every component here reads the query cache (the row's own retry is a mutation, and
 * every `RoomMessage` resolves its actions through one), so the bench brings a
 * throwaway client of its own rather than borrowing the app's. Same shape as
 * `ThreadPanelDemo`, and for the same reason: a showcase that only renders
 * inside the running app is one nobody can test.
 */
export function RoomDeliveryShowcases() {
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
    []
  );
  return (
    <QueryClientProvider client={client}>
      <MomentsSection />
      <NoticesSection />
      <PendingSection />
      <AttachmentsSection />
    </QueryClientProvider>
  );
}
