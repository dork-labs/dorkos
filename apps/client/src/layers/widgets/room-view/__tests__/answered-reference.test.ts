/**
 * Which message an answer says it is answering, and when it says nothing.
 *
 * A room posts in ARRIVAL order, whatever a message is responding to — and a
 * message that waited behind a turn in another conversation is answered out of
 * order routinely rather than rarely (spec `room-hold-when-busy`). The server
 * therefore sets `answersEntryId` on every agent-authored post, unconditionally,
 * because a reader cannot tell from the outside which answers waited. This
 * function is the half that decides whether a reader needs telling.
 *
 * **The suppressions are the feature, not the guard clauses.** The pointer is
 * set on every reply in the product, so a chip that drew whenever one existed
 * would be furniture on every row — and in the ordinary case the answer lands
 * directly under its question, where the link is already obvious. Each branch
 * below is a case where drawing the chip would be noise or a lie, and each is
 * pinned here because the browser walk of the shipped hold only ever reaches the
 * suppressed one.
 *
 * The two call sites disagree about what "previous" MEANS, which is why both are
 * exercised: the room's flow passes the entry above in the top-level flow
 * (`RoomFlow`), and the thread panel passes the root for the first reply and the
 * reply above for every other (`RoomThreadPanel`). A message can be adjacent in
 * one and not in the other, and getting that wrong shows up as a chip that
 * points at the row you are already looking at.
 */
import { describe, it, expect } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { answeredReference } from '../lib/room-timeline';

/**
 * An entry with only what this function reads off one.
 *
 * @param id - The entry's id.
 * @param text - Its words.
 * @param answers - The entry it answers, when it is an agent's reply.
 */
function entry(id: string, text: string, answers?: string): RoomEntry {
  return {
    id,
    body: { text, ...(answers === undefined ? {} : { answersEntryId: answers }) },
  } as unknown as RoomEntry;
}

/** Look an entry up in a loaded page, the way both hosts do. */
function loaded(...entries: RoomEntry[]): (id: string) => RoomEntry | undefined {
  return (id) => entries.find((candidate) => candidate.id === id);
}

describe('answeredReference', () => {
  const question = entry('q1', 'can you take the staging rollout?');
  const interruption = entry('x1', 'never mind, I will look');

  it('quotes the message an out-of-order answer is answering', () => {
    // The branch the whole field exists for, and the one a browser walk of the
    // shipped hold never reaches: somebody said something else while the answer
    // was waiting, so the reply does not land under its own question.
    const answer = entry('a1', 'rollout is queued', 'q1');

    expect(answeredReference(answer, interruption, loaded(question, interruption, answer))).toEqual(
      { entryId: 'q1', excerpt: 'can you take the staging rollout?' }
    );
  });

  it('says nothing when the post answers nothing', () => {
    // A person's own message, and every entry written before the field existed.
    expect(answeredReference(entry('p1', 'morning'), question, loaded(question))).toBeNull();
  });

  it('says nothing when the answered entry is the row directly above', () => {
    // **The suppression that keeps the chip from being furniture.** The pointer
    // is set on EVERY agent-authored post, so without this every reply in the
    // product would carry a chip pointing at the message immediately above it.
    const answer = entry('a1', 'rollout is queued', 'q1');

    expect(answeredReference(answer, question, loaded(question, answer))).toBeNull();
  });

  it('says nothing about a post that points at itself', () => {
    // Not reachable from the server today, and cheap to refuse: a chip quoting
    // the row it is drawn on is a reference to nowhere.
    const selfish = entry('a1', 'rollout is queued', 'a1');

    expect(answeredReference(selfish, interruption, loaded(selfish, interruption))).toBeNull();
  });

  it('says nothing when the answered message is not in the loaded page', () => {
    // A room loads its trailing history, so an answer that waited a long time
    // can point above the top of it. Quoting a message this client does not hold
    // would mean inventing the words.
    const answer = entry('a1', 'rollout is queued', 'q-scrolled-away');

    expect(answeredReference(answer, interruption, loaded(interruption, answer))).toBeNull();
  });

  it('says nothing when the answered message has no words to quote', () => {
    // An entry whose text is whitespace — an attachment-only post is the real
    // shape. A chip reading `Answering “”` is worse than no chip.
    const blank = entry('q1', '   \n  ');
    const answer = entry('a1', 'rollout is queued', 'q1');

    expect(answeredReference(answer, interruption, loaded(blank, interruption, answer))).toBeNull();
  });

  it('is drawn at the top of the loaded page, where there is no previous row', () => {
    // `previous` is `undefined` for the first row a host draws. That is not a
    // reason to suppress: it means nothing is above this answer, so the reader
    // has nothing to read the link off.
    const answer = entry('a1', 'rollout is queued', 'q1');

    expect(answeredReference(answer, undefined, loaded(question, answer))).toEqual({
      entryId: 'q1',
      excerpt: 'can you take the staging rollout?',
    });
  });

  it('cuts a long question short, and collapses the whitespace it kept', () => {
    // The chip is a pointer, not a quote: longer than this and it competes with
    // the answer it sits above. The newline is collapsed because a quote that
    // wrapped would break the one-line row.
    const long = entry(
      'q1',
      'can you take the staging rollout,\n   and then check the migration afterwards?'
    );
    const answer = entry('a1', 'on it', 'q1');
    const chip = answeredReference(answer, interruption, loaded(long, interruption, answer));

    expect(chip?.excerpt).toBe('can you take the staging rollout, and then check…');
    expect(chip?.excerpt).not.toContain('\n');
  });

  it('leaves a question that fits exactly alone', () => {
    // The boundary, so the truncation cannot creep a character either way.
    const exact = entry('q1', 'x'.repeat(48));
    const answer = entry('a1', 'on it', 'q1');

    expect(
      answeredReference(answer, interruption, loaded(exact, interruption, answer))?.excerpt
    ).toBe('x'.repeat(48));
  });

  describe("the two hosts' different notion of 'previous'", () => {
    // The same reply, judged against what each surface actually DRAWS above it.
    // A thread's first reply sits under the root; the room's flow does not draw
    // thread replies at all, so what is above a top-level answer there is the
    // previous TOP-LEVEL entry.
    const root = entry('root', 'can somebody check the deploy');
    const firstReply = entry('r1', 'on it', 'root');
    const secondReply = entry('r2', 'still going', 'root');
    const page = loaded(root, firstReply, secondReply);

    it("suppresses a thread's first reply, which sits under its root", () => {
      // `RoomThreadPanel` passes the ROOT for `replyIndex <= 0`.
      expect(answeredReference(firstReply, root, page)).toBeNull();
    });

    it('draws on a later reply that answers the root again', () => {
      // `RoomThreadPanel` passes `replies[replyIndex - 1]` from the second reply
      // on — so this one answers the root with another reply in between, and the
      // link is no longer obvious.
      expect(answeredReference(secondReply, firstReply, page)).toEqual({
        entryId: 'root',
        excerpt: 'can somebody check the deploy',
      });
    });

    it("draws in the room's flow when a thread reply sat between the two", () => {
      // The flow's `previous` is `topLevel[index - 1]`, which skips the thread
      // reply the panel would have counted — so the same pair of entries can be
      // adjacent in one surface and not in the other, and each host is asked
      // about its own.
      const answer = entry('a1', 'rollout is queued', 'q1');
      expect(
        answeredReference(answer, question, loaded(question, firstReply, answer)),
        'adjacent in the flow: suppressed'
      ).toBeNull();
      expect(
        answeredReference(answer, firstReply, loaded(question, firstReply, answer)),
        'a reply drawn between them: the chip is worth drawing'
      ).toEqual({ entryId: 'q1', excerpt: 'can you take the staging rollout?' });
    });
  });
});
