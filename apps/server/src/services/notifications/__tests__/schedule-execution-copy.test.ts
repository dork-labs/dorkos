import { describe, expect, it } from 'vitest';
import { scheduleExecutionCopy } from '../schedule-execution-copy.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../runtimes/codex/runtime-constants.js';

describe('a created schedule describes its resolved mode', () => {
  it('does not describe Codex workspace write as waiting for an absent person', () => {
    const copy = scheduleExecutionCopy('acceptEdits', CODEX_CAPABILITIES);
    expect(copy.modeLabel).toBe('Workspace write');
    expect(copy.limitation).toContain('within its limits');
    expect(copy.limitation).not.toContain('nobody');
  });

  it('describes Never ask as an intentional refusal', () => {
    expect(scheduleExecutionCopy('dontAsk', CLAUDE_CODE_CAPABILITIES).limitation).toBe(
      'Only allowed commands run. Others are refused without asking.'
    );
  });

  it('does not promise execution in Plan or approval prompts in Full autonomy', () => {
    expect(scheduleExecutionCopy('plan', CLAUDE_CODE_CAPABILITIES).limitation).toContain(
      'Reads and plans only'
    );
    expect(scheduleExecutionCopy('bypassPermissions', CLAUDE_CODE_CAPABILITIES).limitation).toBe(
      'Commands run without waiting for approval.'
    );
  });

  it('does not invent permissions for an undeclared mode', () => {
    expect(scheduleExecutionCopy('future-mode')).toEqual({
      modeLabel: 'Unknown mode',
      limitation: 'This mode’s command permissions could not be checked.',
      refusesUnansweredApprovals: false,
    });
  });
});
