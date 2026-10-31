import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { refuseOutsiderAgentFiles } from '../agent-file-inputs.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';

const AGENT = { sessionId: 'unmarked-chat', identity: { agentPath: '/agents/ana' } };

describe('a person’s limits on an agent’s files (DOR-3440)', () => {
  it.each([[{ memoryContent: 'x' }], [{ conventions: { memory: false } }]])(
    'refuses %j from an unmarked agent turn',
    (input) => {
      expect(() => refuseOutsiderAgentFiles(input, AGENT)).toThrow();
    }
  );

  it('lets an unmarked agent turn change its own words and its other switches', () => {
    expect(refuseOutsiderAgentFiles({ soulContent: 'x' }, AGENT)).toBeUndefined();
    expect(refuseOutsiderAgentFiles({ conventions: { soul: false } }, AGENT)).toBeUndefined();
  });

  it('lets a caller with no agent behind it through', () => {
    expect(refuseOutsiderAgentFiles({ nopeContent: 'x' }, {})).toBeUndefined();
  });

  it('treats a turn with only a teammate’s mark as any other: words yes, limits no', async () => {
    const sessionId = 'teammate-marked-chat';
    const runtime = recordTurnLevels(
      {
        type: 'claude-code',
        getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
        async *sendMessage(): AsyncGenerator<StreamEvent> {
          yield { type: 'done', data: {} } as StreamEvent;
        },
      } as unknown as AgentRuntime,
      () => 'default'
    );
    const turn = runtime.sendMessage(sessionId, 'hi', {
      permissionCeiling: {
        asks: 'never',
        reach: 'everything',
        teammate: [{ roomId: 'r', authorId: 'a' }],
      },
    });
    for await (const _event of turn) {
      // drain
    }
    const context = { sessionId, identity: { agentPath: '/agents/ana' } };
    expect(refuseOutsiderAgentFiles({ soulContent: 'x' }, context)).toBeUndefined();
    expect(() => refuseOutsiderAgentFiles({ memoryContent: 'x' }, context)).toThrow();
  });
});
