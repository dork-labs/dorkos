import { describe, it, expect } from 'vitest';
import { UI_COMMAND_REACH } from '@dorkos/shared/schemas';
import { reachesPastTheScreen, uiActionRefusalMessage } from '../ui-surface-consent.js';

/**
 * The refusal predicate reads the shared reach table, so a new `control_ui`
 * action is covered by whatever verdict `UI_COMMAND_REACH` gives it — nothing
 * here needs editing when the union grows (DOR-639).
 *
 * It tests the SURFACE, not a runtime's name (spec `canvas-agent-seat` §5). Both
 * Codex and OpenCode reach `control_ui` through the loopback runtime listener
 * now, and neither has a way to put a question to the person before an action
 * writes to their machine — so one rule covers both, and covers whatever runtime
 * arrives next through the same door.
 */
describe('reachesPastTheScreen', () => {
  it('refuses exactly the actions UI_COMMAND_REACH says leave the browser', () => {
    for (const [action, reach] of Object.entries(UI_COMMAND_REACH)) {
      expect(reachesPastTheScreen(action), action).toBe(reach !== 'client-only');
    }
  });

  it('lets an unknown action through to the parse, which rejects it as invalid', () => {
    // Fail-closed lives in the handler's own parse: an action outside the union
    // has no reach verdict here, and `UiCommandSchema` there turns it into an
    // "Invalid UI command" refusal rather than a command. Prototype keys must not
    // read as verdicts.
    expect(reachesPastTheScreen('not_a_real_action')).toBe(false);
    expect(reachesPastTheScreen('toString')).toBe(false);
    expect(reachesPastTheScreen('constructor')).toBe(false);
  });
});

describe('uiActionRefusalMessage', () => {
  it('names the action and where to go instead, and claims nothing about cron', () => {
    const message = uiActionRefusalMessage('apply_layout');

    expect(message).toContain('apply_layout');
    expect(message).toContain('DorkOS app');
    // The rationale this refusal rests on is that the action WRITES. An earlier
    // draft said it armed schedules carrying `bypassPermissions`, which is false
    // on this tree twice over (DOR-607 clamps the mode, DOR-1486 parks the
    // schedule pending approval). Pinned so the false claim cannot creep back in
    // through the one string a user or an agent actually reads.
    expect(message).not.toMatch(/bypass/i);
    expect(message).not.toMatch(/unattended/i);
  });
});
