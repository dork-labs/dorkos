import { describe, it, expect } from 'vitest';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { toAgentPickerCandidates } from '../agent-choices';

/** A manifest with no stored face, so its colour and emoji are hashed from its id. */
function manifest(id: string) {
  return { id };
}

describe('toAgentPickerCandidates', () => {
  it('sorts by the name on screen, not by the path behind it', () => {
    // Paths ordered z, a, m; names ordered Ana, Bo, Kai. The reader is scanning
    // names, so a path-ordered list would look shuffled.
    const candidates = toAgentPickerCandidates(
      {
        '/w/zeta': 'Kai',
        '/w/alpha': 'Bo',
        '/w/mid': 'Ana',
      },
      {}
    );

    expect(candidates.map((c) => c.agentPath)).toEqual(['/w/mid', '/w/alpha', '/w/zeta']);
    expect(candidates.map((c) => c.displayName)).toEqual(['Ana', 'Bo', 'Kai']);
  });

  it('puts an accented name where a person looks for it', () => {
    // Code-unit ordering would file Éowyn after Zed, at the end of the list.
    const candidates = toAgentPickerCandidates({ '/w/z': 'Zed', '/w/e': 'Éowyn' }, {});
    expect(candidates.map((c) => c.displayName)).toEqual(['Éowyn', 'Zed']);
  });

  it('answers with nothing for a fleet of nobody', () => {
    expect(toAgentPickerCandidates({}, {})).toEqual([]);
  });

  it('gives an agent the same face every other surface draws for it', () => {
    // Not "a face" — THE face. The sidebar row, the message gutter and this
    // list all run the manifest through `resolveAgentVisual`, so an agent that
    // looked different in a picker would read as a different agent.
    const ana = manifest('01JAAAAAAAAAAAAAAAAAAAAAAA');

    const [candidate] = toAgentPickerCandidates({ '/w/ana': 'Ana' }, { '/w/ana': ana });

    expect(candidate.visual).toEqual(resolveAgentVisual(ana));
  });

  it('prefers the agent’s own stored colour and emoji over a hashed one', () => {
    const [candidate] = toAgentPickerCandidates(
      { '/w/ana': 'Ana' },
      { '/w/ana': { id: '01JAAAAAAAAAAAAAAAAAAAAAAA', color: '#6366f1', icon: '🔍' } }
    );

    expect(candidate.visual).toEqual({ color: '#6366f1', emoji: '🔍' });
  });

  it('carries what an agent says it is for, in the agent’s own words', () => {
    const [candidate] = toAgentPickerCandidates(
      { '/w/ana': 'Ana' },
      { '/w/ana': { id: '01JAAAAAAAAAAAAAAAAAAAAAAA', description: 'Reviews pull requests' } }
    );

    expect(candidate.description).toBe('Reviews pull requests');
  });

  it('says nothing rather than nothing-shaped when the agent has not', () => {
    // `description` defaults to `''` on the manifest, so most agents have one
    // that says nothing. A picker draws a second line for a description and NO
    // second line for the absence of one, so the two have to be told apart here
    // — red if `''` or a field of spaces ever reaches a caller as a value.
    const candidates = toAgentPickerCandidates(
      { '/w/a': 'A', '/w/b': 'B', '/w/c': 'C' },
      {
        '/w/a': { id: '01JAAAAAAAAAAAAAAAAAAAAAAA', description: '' },
        '/w/b': { id: '01JBBBBBBBBBBBBBBBBBBBBBBB', description: '   ' },
        '/w/c': { id: '01JCCCCCCCCCCCCCCCCCCCCCCC' },
      }
    );

    expect(candidates.map((c) => c.description)).toEqual([null, null, null]);
  });

  it('carries no face at all for an agent whose manifest could not be read', () => {
    // The directory is right there and hashing it would produce a stable,
    // confident face — one that matches nothing the rest of the cockpit draws.
    // A picker that guesses would be the surface that looks most certain and is
    // most wrong, so it says it does not know and the UI draws a letter.
    const candidates = toAgentPickerCandidates(
      { '/w/ana': 'Ana', '/w/bo': 'Bo', '/w/kai': 'Kai' },
      { '/w/ana': null, '/w/bo': undefined }
    );

    expect(candidates.map((c) => c.visual)).toEqual([null, null, null]);
  });
});
