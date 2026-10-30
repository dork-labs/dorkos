import { describe, expect, it } from 'vitest';
import { refuseOutsiderAgentFiles } from '../agent-file-inputs.js';

const AGENT = { sessionId: 'unmarked-chat', identity: { agentPath: '/agents/ana' } };

describe('a person’s limits on an agent’s files (DOR-3440)', () => {
  it.each(['nopeContent', 'memoryContent', 'conventions'])(
    'refuses %s from an unmarked agent turn',
    (field) => {
      expect(() => refuseOutsiderAgentFiles({ [field]: 'x' }, AGENT)).toThrow();
    }
  );

  it('lets an unmarked agent turn change its own words', () => {
    expect(refuseOutsiderAgentFiles({ soulContent: 'x' }, AGENT)).toBeUndefined();
  });

  it('lets a caller with no agent behind it through', () => {
    expect(refuseOutsiderAgentFiles({ nopeContent: 'x' }, {})).toBeUndefined();
  });
});
