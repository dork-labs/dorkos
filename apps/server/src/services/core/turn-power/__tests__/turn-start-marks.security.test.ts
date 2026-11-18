/** Security's proof (DOR-4693 PR 2 review), turned to the fixed behaviour: a continuation and an unknown id fail closed. */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { markRunningTurnOutsider, recordTurnLevels } from '../turn-levels.js';
import { turnStartedMarked } from '../turn-start-marks.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { liveOutsideTurnCheck } from '../../../session/local-browser/outside-turn.js';

let n = 0;
const fresh = () => `sec-4693-${(n += 1)}`;
async function turn(sessionId: string, opts?: MessageOpts): Promise<void> {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _e of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}
const check = liveOutsideTurnCheck({
  agentPathOf: async () => null,
  launchOriginOf: () => 'interactive',
});
afterEach(() => resetLiveOutsiderTurns());

describe('DOR-4693: continuations and unknown ids fail closed', () => {
  it('a continuation of a stranger-held turn stays the stranger’s, after a page read too', async () => {
    const chat = fresh();
    await turn(chat, { permissionCeiling: 'runtime-default' }); // a stranger's hold
    expect(turnStartedMarked(chat)).toBe(true);
    markRunningTurnOutsider(chat); // the stranger turn also read a page
    await turn(chat, { permissionCeiling: 'runtime-default', continuationHold: true }); // usage-limit resume
    expect(turnStartedMarked(chat)).toBe(true);
    await expect(check(chat)).resolves.toBe('outsider_turn');
  });

  it('an id with no start record but an outsider mark reads as the turn’s own mark', async () => {
    const unknown = liveOutsideTurnCheck({
      agentPathOf: async () => '/agents/a',
      launchOriginOf: () => null,
      marksOf: () => ({ outsider: true }), // e.g. marksOf's agent-wide fallback
    });
    await expect(unknown('never-recorded')).resolves.toBe('outsider_turn');
  });
});
