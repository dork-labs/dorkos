import { describe, it, expect } from 'vitest';
import { toAgentPickerCandidates } from '../agent-choices';

describe('toAgentPickerCandidates', () => {
  it('sorts by the name on screen, not by the path behind it', () => {
    // Paths ordered z, a, m; names ordered Ana, Bo, Kai. The reader is scanning
    // names, so a path-ordered list would look shuffled.
    const candidates = toAgentPickerCandidates({
      '/w/zeta': 'Kai',
      '/w/alpha': 'Bo',
      '/w/mid': 'Ana',
    });

    expect(candidates).toEqual([
      { agentPath: '/w/mid', displayName: 'Ana' },
      { agentPath: '/w/alpha', displayName: 'Bo' },
      { agentPath: '/w/zeta', displayName: 'Kai' },
    ]);
  });

  it('puts an accented name where a person looks for it', () => {
    // Code-unit ordering would file Éowyn after Zed, at the end of the list.
    const candidates = toAgentPickerCandidates({ '/w/z': 'Zed', '/w/e': 'Éowyn' });
    expect(candidates.map((c) => c.displayName)).toEqual(['Éowyn', 'Zed']);
  });

  it('answers with nothing for a fleet of nobody', () => {
    expect(toAgentPickerCandidates({})).toEqual([]);
  });
});
