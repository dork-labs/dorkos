import { describe, it, expect } from 'vitest';
import {
  PRESENCE_NAME_LIMIT,
  heldCountSentence,
  heldSentence,
  presenceCountSentence,
  presenceDetail,
  presenceRow,
  presenceSentence,
} from '../lib/presence-copy';

describe('presenceSentence', () => {
  it('names one agent that is working', () => {
    expect(presenceSentence(['Kai'], 'working')).toBe('Kai is working on it');
  });

  it('says a single long wait out loud', () => {
    expect(presenceSentence(['Kai'], 'working_late')).toBe(
      'Kai is still working, this is taking longer than usual'
    );
  });

  it('reads two or three names as a list', () => {
    expect(presenceSentence(['Kai', 'Ana'], 'working')).toBe('Kai and Ana are working on it');
    expect(presenceSentence(['Kai', 'Ana', 'Sam'], 'working')).toBe(
      'Kai, Ana and Sam are working on it'
    );
  });

  it('says a long wait at more than one name too', () => {
    // THE assertion of this fix. The taking-longer wording used to be the
    // single-agent case only, so the moment a second agent picked something up
    // the room stopped saying that anything was slow — the exact case where a
    // person most needs to be told. Red if the count decides the wording again.
    expect(presenceSentence(['Kai', 'Ana'], 'working_late')).toBe(
      'Kai and Ana are still working, this is taking longer than usual'
    );
    expect(presenceSentence(['Kai', 'Ana', 'Sam'], 'working_late')).toBe(
      'Kai, Ana and Sam are still working, this is taking longer than usual'
    );
  });
});

describe('presenceCountSentence', () => {
  it('counts past the naming limit', () => {
    expect(presenceCountSentence(PRESENCE_NAME_LIMIT + 1, 'working')).toBe(
      '4 agents are working on it'
    );
  });

  it('carries the long wait into the count', () => {
    expect(presenceCountSentence(4, 'working_late')).toBe(
      '4 agents are still working, this is taking longer than usual'
    );
  });
});

describe('presenceRow', () => {
  it('prints a name and what the claim is bound to', () => {
    expect(presenceRow('tangerines', 'replying in #release-train', 'working')).toBe(
      'tangerines · replying in #release-train'
    );
  });

  it('says nothing but the name when nothing can say where', () => {
    // The whole no-binding rule in one assertion: a row that cannot name the
    // binding says the name and stops. Red the moment anything invents a
    // stand-in clause ("working on something", "somewhere") to fill the gap.
    expect(presenceRow('DorkBot', null, 'working')).toBe('DorkBot');
  });

  it('still admits a long wait with no binding to hang it on', () => {
    expect(presenceRow('DorkBot', null, 'working_late')).toBe('DorkBot · taking longer than usual');
  });
});

describe('presenceDetail', () => {
  it('is absent when there is neither a binding nor a long wait', () => {
    expect(presenceDetail(null, 'working')).toBeNull();
  });

  it('is absent for an empty binding, which is not a binding', () => {
    expect(presenceDetail('', 'working')).toBeNull();
  });

  it('carries the long wait behind the binding', () => {
    expect(presenceDetail('replying in #team', 'working_late')).toBe(
      'replying in #team · taking longer than usual'
    );
  });
});

describe('heldSentence', () => {
  it('names the conversation in the way when this reader can see it', () => {
    expect(heldSentence(['Mio Clicker PM'], '#mio-engagement')).toBe(
      'Mio Clicker PM will pick this up when it finishes in #mio-engagement'
    );
  });

  it('stays vague when this reader cannot', () => {
    // The disclosure rule, in one assertion. The wire carries a room ID and the
    // reader resolves it against the rooms they can already see; a reader who
    // cannot see that room is told THAT something is in the way and never which
    // conversation. Red the moment this falls back to an id, a slug or nothing.
    expect(heldSentence(['Mio Clicker PM'], null)).toBe(
      'Mio Clicker PM will pick this up when it finishes in another conversation'
    );
  });

  it('drops the room once more than one agent is waiting', () => {
    // With two there is more than one conversation in the way, and naming one of
    // them would be picking a favourite that the sentence cannot justify.
    expect(heldSentence(['Mio Clicker PM', 'Ana'], '#mio-engagement')).toBe(
      "Mio Clicker PM and Ana will pick this up when they're free"
    );
  });

  it('never asks anybody to send anything again', () => {
    // The whole point of the change: the sentence this replaced ended "Send it
    // again in a few minutes."
    for (const sentence of [
      heldSentence(['Mio Clicker PM'], '#mio-engagement'),
      heldSentence(['Mio Clicker PM'], null),
      heldSentence(['Mio Clicker PM', 'Ana'], null),
      heldCountSentence(4),
    ]) {
      expect(sentence).not.toContain('again');
    }
  });
});

describe('heldCountSentence', () => {
  it('counts past the naming limit', () => {
    expect(heldCountSentence(PRESENCE_NAME_LIMIT + 1)).toBe(
      "4 agents will pick this up when they're free"
    );
  });
});
