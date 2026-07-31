import { describe, it, expect } from 'vitest';
import {
  PRESENCE_NAME_LIMIT,
  presenceCountSentence,
  presenceListRow,
  presenceSentence,
} from '../lib/presence-copy';

describe('presenceSentence', () => {
  it('names one agent that is working', () => {
    expect(presenceSentence(['Kai'], 'working')).toBe('Kai is working on it');
  });

  it('says a single long wait out loud', () => {
    expect(presenceSentence(['Kai'], 'working_late')).toBe(
      'Kai is still working — this is taking longer than usual'
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
      'Kai and Ana are still working — this is taking longer than usual'
    );
    expect(presenceSentence(['Kai', 'Ana', 'Sam'], 'working_late')).toBe(
      'Kai, Ana and Sam are still working — this is taking longer than usual'
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
      '4 agents are still working — this is taking longer than usual'
    );
  });
});

describe('presenceListRow', () => {
  it('prints a name and how long it has been going', () => {
    expect(presenceListRow('Kai', 'working', '3m')).toBe('Kai · 3m');
  });

  it('marks the row that has outrun the room', () => {
    // The expanded list dropped state entirely, so four agents with one of them
    // twenty minutes late read exactly like four healthy ones.
    expect(presenceListRow('Kai', 'working_late', '20m')).toBe(
      'Kai · 20m · taking longer than usual'
    );
  });
});
